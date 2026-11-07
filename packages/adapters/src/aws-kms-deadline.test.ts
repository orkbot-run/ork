// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type * as KmsSdk from "@aws-sdk/client-kms";
import { KMSClient } from "@aws-sdk/client-kms";
import { afterEach, expect, it, vi } from "vitest";
import { AwsKmsKeyProvider } from "./aws-kms-key-provider.js";

const KEY_ARN = "arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const config = { keyArn: KEY_ARN, accessKeyId: "fake-access", secretAccessKey: "fake-secret" };
const context = { spaceId: "space-a", version: 1 };
const cleanup: Array<() => void | Promise<void>> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function serverClient(
  respond: (
    input: Record<string, unknown>,
    request: IncomingMessage,
    response: ServerResponse,
  ) => void,
  options: Partial<KmsSdk.KMSClientConfig> = {},
) {
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") return response.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push(input);
    respond(input, request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new KMSClient({
    region: "eu-central-1",
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 1,
    ...options,
  });
  cleanup.push(async () => {
    client.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const signals: Array<AbortSignal | undefined> = [];
  const handler = client.config.requestHandler;
  const handle = handler.handle.bind(handler);
  const headers = deferred<void>();
  const secondHeaders = deferred<void>();
  const bodies: IncomingMessage[] = [];
  vi.spyOn(handler, "handle").mockImplementation(async (request, settings) => {
    signals.push((settings as { abortSignal?: AbortSignal } | undefined)?.abortSignal);
    const result = await handle(request, settings);
    bodies.push(result.response.body as IncomingMessage);
    headers.resolve();
    if (bodies.length === 2) secondHeaders.resolve();
    return result;
  });
  const provider = new AwsKmsKeyProvider(config, client);
  return {
    client,
    provider,
    requests,
    signals,
    headers,
    secondHeaders,
    bodies,
    sockets,
  };
}

it.each(["wrap", "unwrap"] as const)(
  "aborts a stalled %s body and closes that request's socket after headers",
  async (operation) => {
    const peerClosed = deferred<void>();
    const harness = await serverClient((_input, request, response) => {
      request.socket.once("close", () => peerClosed.resolve());
      response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      response.flushHeaders();
      response.write('{"CiphertextBlob":"');
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = outcome<unknown>(
      operation === "wrap"
        ? harness.provider.wrap(Buffer.alloc(32, 7), context)
        : harness.provider.unwrap(
            {
              masterKeyId: "aws-kms:1234abcd-12ab-34cd-56ef-1234567890ab",
              wrappedKey: Buffer.alloc(48, 7).toString("base64url"),
            },
            context,
          ),
    );
    await harness.headers.promise;
    expect(harness.signals[0]).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(harness.signals[0]?.aborted).toBe(true);
    await peerClosed.promise;
    expect(harness.bodies[0]?.destroyed).toBe(true);
    expect(harness.sockets.size).toBe(0);
    expect(harness.requests).toHaveLength(1);
  },
);

it("bounds an uncooperative SDK promise and handles its late completion", async () => {
  const started = deferred<void>();
  const response = deferred<{ CiphertextBlob: Buffer }>();
  const send = vi.fn((_command: unknown, _options: unknown) => {
    started.resolve();
    return response.promise;
  });
  const provider = new AwsKmsKeyProvider(config, { send } as unknown as KMSClient);
  vi.useFakeTimers();
  const pending = outcome(provider.wrap(Buffer.alloc(32), context));
  await started.promise;
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ message: "Key manager request timed out" });
  response.resolve({ CiphertextBlob: Buffer.alloc(48) });
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it("starts the deadline before lazy connection and never dispatches when it resolves too late", async () => {
  const send = vi.fn();
  const client = { send } as unknown as KMSClient;
  const provider = new AwsKmsKeyProvider(config, client);
  const connection = deferred<{ sdk: typeof KmsSdk; client: KMSClient }>();
  vi.spyOn(
    provider as unknown as { connect: () => typeof connection.promise },
    "connect",
  ).mockReturnValue(connection.promise);
  vi.useFakeTimers();
  const pending = outcome(provider.wrap(Buffer.alloc(32), context));
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await pending;
  expect(result.ok).toBe(false);
  connection.resolve({ sdk: await import("@aws-sdk/client-kms"), client });
  await Promise.resolve();
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});

it("clears the successful operation's deadline while keeping another operation independent", async () => {
  const started = deferred<void>();
  const first = deferred<{ CiphertextBlob: Buffer }>();
  const signals: Array<AbortSignal | undefined> = [];
  const send = vi.fn((_command: unknown, settings: { abortSignal: AbortSignal }) => {
    signals.push(settings?.abortSignal);
    started.resolve();
    return signals.length === 1
      ? first.promise
      : Promise.resolve({ CiphertextBlob: Buffer.alloc(48, 9) });
  });
  const provider = new AwsKmsKeyProvider(config, { send } as unknown as KMSClient);
  vi.useFakeTimers();
  const pending = outcome(provider.wrap(Buffer.alloc(32), context));
  await started.promise;
  const successful = await provider.wrap(Buffer.alloc(32), { ...context, spaceId: "space-b" });
  expect(successful.wrappedKey).toBe(Buffer.alloc(48, 9).toString("base64url"));
  expect(signals[0]).toBeDefined();
  expect(signals[1]).toBeDefined();
  expect(signals[0]).not.toBe(signals[1]);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).ok).toBe(false);
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  first.resolve({ CiphertextBlob: Buffer.alloc(48) });
});

it("returns at the single deadline during SDK backoff and never sends another HTTP request", async () => {
  const retrySeen = deferred<void>();
  const token = (count: number) => ({
    getRetryCount: () => count,
    getRetryDelay: () => 20_000,
    getRetryCost: () => 1,
  });
  const retryStrategy: KmsSdk.KMSClientConfig["retryStrategy"] = {
    acquireInitialRetryToken: async () => token(0),
    refreshRetryTokenForRetry: async (previous, info) => {
      if (
        !["SERVER_ERROR", "TRANSIENT", "THROTTLING"].includes(info.errorType) ||
        previous.getRetryCount() >= 2
      )
        throw new Error("No retry");
      retrySeen.resolve();
      return token(previous.getRetryCount() + 1);
    },
    recordSuccess: () => undefined,
  };
  const harness = await serverClient(
    (_input, _request, response) =>
      response
        .writeHead(500, { "content-type": "application/x-amz-json-1.1" })
        .end(JSON.stringify({ __type: "KMSInternalException", message: "fake retryable failure" })),
    { retryStrategy, maxAttempts: 3 },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = outcome(harness.provider.wrap(Buffer.alloc(32), context));
  await retrySeen.promise;
  expect(harness.signals[0]).toBeDefined();
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).ok).toBe(false);
  expect(harness.signals[0]?.aborted).toBe(true);
  // Smithy's cooldown cannot be cancelled. Drain it to prove no later HTTP attempt escapes.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(harness.requests).toHaveLength(1);
  expect(harness.signals.every((signal) => signal === harness.signals[0])).toBe(true);
});

it("keeps the original total budget when a retry sends headers then stalls its body", async () => {
  const retrySeen = deferred<void>();
  const closed = deferred<void>();
  const token = (count: number) => ({
    getRetryCount: () => count,
    getRetryDelay: () => 6000,
    getRetryCost: () => 1,
  });
  const retryStrategy: KmsSdk.KMSClientConfig["retryStrategy"] = {
    acquireInitialRetryToken: async () => token(0),
    refreshRetryTokenForRetry: async (previous, info) => {
      if (
        previous.getRetryCount() >= 1 ||
        !["SERVER_ERROR", "TRANSIENT", "THROTTLING"].includes(info.errorType)
      )
        throw new Error("No retry");
      retrySeen.resolve();
      return token(1);
    },
    recordSuccess: () => undefined,
  };
  let requestCount = 0;
  const harness = await serverClient(
    (_input, request, response) => {
      if (++requestCount === 1) {
        response
          .writeHead(500, { "content-type": "application/x-amz-json-1.1" })
          .end(
            JSON.stringify({ __type: "KMSInternalException", message: "fake transient failure" }),
          );
        return;
      }
      request.socket.once("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      response.flushHeaders();
      response.write('{"CiphertextBlob":"');
    },
    { retryStrategy, maxAttempts: 2 },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = outcome(harness.provider.wrap(Buffer.alloc(32), context));
  await retrySeen.promise;
  expect(harness.signals[0]).toBeDefined();
  await vi.advanceTimersByTimeAsync(6000);
  await harness.secondHeaders.promise;
  expect(harness.signals[1]).toBe(harness.signals[0]);
  await vi.advanceTimersByTimeAsync(3999);
  expect(harness.signals[0]?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await pending).ok).toBe(false);
  await closed.promise;
  expect(harness.bodies[1]?.destroyed).toBe(true);
  expect(harness.requests).toHaveLength(2);
});

it("does not destroy another request on the shared client when the earlier deadline expires", async () => {
  const responses = new Map<string, ServerResponse>();
  const firstClosed = deferred<void>();
  const harness = await serverClient((input, request, response) => {
    const space = (input.EncryptionContext as Record<string, string>)["orkbot:space"]!;
    responses.set(space, response);
    if (space === "space-a") request.socket.once("close", () => firstClosed.resolve());
    response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
    response.flushHeaders();
    response.write('{"CiphertextBlob":"');
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = outcome(harness.provider.wrap(Buffer.alloc(32), context));
  await harness.headers.promise;
  expect(harness.signals[0]).toBeDefined();
  await vi.advanceTimersByTimeAsync(5000);
  const second = outcome(
    harness.provider.wrap(Buffer.alloc(32), { ...context, spaceId: "space-b" }),
  );
  await harness.secondHeaders.promise;
  expect(harness.signals[1]).not.toBe(harness.signals[0]);
  await vi.advanceTimersByTimeAsync(5000);
  expect((await first).ok).toBe(false);
  await firstClosed.promise;
  expect(harness.bodies[1]?.destroyed).toBe(false);
  responses.get("space-b")!.end(`${Buffer.alloc(48, 9).toString("base64")}"}`);
  const result = await second;
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.wrappedKey).toBe(Buffer.alloc(48, 9).toString("base64url"));
  expect(harness.signals[1]?.aborted).toBe(false);
});
