// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  generation: 1,
  target: undefined as unknown,
  listener: undefined as ((event: unknown) => void) | undefined,
  listeners: [] as ((event: unknown) => void)[],
  clear: undefined as (() => void) | undefined,
  fetch: vi.fn<typeof fetch>(),
  configure: vi.fn<(...args: string[]) => Promise<void>>(),
  reply: vi.fn<(...args: unknown[]) => Promise<void>>(),
  reset: vi.fn(async () => {}),
}));
vi.mock("expo-crypto", () => ({ randomUUID }));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
vi.mock("./client-update", () => ({
  clientBuildHeaders: () => ({ "x-orkbot-client-build": "mobile-fixture" }),
}));
vi.mock("./installation-transport", () => ({
  installationRevocationScope: () => fake.target,
  fetchInstallation: fake.fetch,
}));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({ "x-proxy-fixture": "test" }) }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => fake.generation,
  registerSessionDiskCache: (callback: () => void) => {
    fake.clear = callback;
  },
}));

const endpoint = "https://00000000-0000-4000-8000-000000000001.installation.ork.invalid";
const native = {
  addListener: (name: string, callback: (event: unknown) => void) => {
    expect(name).toBe("onBackgroundRequest");
    fake.listener = callback;
    fake.listeners.push(callback);
    return { remove() {} };
  },
  configureBackgroundSession: fake.configure,
  respondBackgroundRequest: fake.reply,
  clearBackgroundSessions: fake.reset,
};
beforeEach(() => {
  vi.resetModules();
  fake.generation = 1;
  fake.target = {
    account: ["https://accounts.example.test", "owner"],
    target: { workspaceId: "workspace-a", bindingVersion: 1 },
  };
  fake.listener = undefined;
  fake.listeners = [];
  fake.clear = undefined;
  fake.fetch.mockReset().mockImplementation(async () => new Response('{"json":{"items":[]}}'));
  fake.configure.mockReset().mockResolvedValue(undefined);
  fake.reply.mockReset().mockResolvedValue(undefined);
  fake.reset.mockReset().mockResolvedValue(undefined);
});

async function prepare() {
  const { prepareNotificationTransport } = await import("./notification-transport");
  await prepareNotificationTransport(native, endpoint, "product-session-fixture", "workspace-a");
  return prepareNotificationTransport;
}
function send(procedure = "runs/list", scope = fake.configure.mock.calls.at(-1)![0]!) {
  const id = randomUUID();
  for (const listener of fake.listeners)
    listener({ id, scope, procedure, input: '{"filter":"active"}' });
  return id;
}

it("uses the captured product session, protocol and workspace only through pinned installation fetch", async () => {
  const again = await prepare();
  await again(native, endpoint, "product-session-fixture", "workspace-a");
  expect(fake.configure).toHaveBeenCalledTimes(1);
  const id = send();
  await vi.waitFor(() => expect(fake.reply).toHaveBeenCalled());
  expect(fake.fetch).toHaveBeenCalledWith(
    `${endpoint}/rpc/runs/list`,
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
      method: "POST",
      headers: {
        "x-proxy-fixture": "test",
        "x-orkbot-client-build": "mobile-fixture",
        "content-type": "application/json",
        origin: "orkbot://",
        "cache-control": "no-store",
        [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
        authorization: "Bearer product-session-fixture",
        "x-orkbot-space-id": "workspace-a",
      },
      body: '{"json":{"filter":"active"}}',
    }),
  );
  expect(fake.reply).toHaveBeenCalledWith(
    id,
    fake.configure.mock.calls[0]![0],
    200,
    '{"json":{"items":[]}}',
  );
});

it("refuses retired workspace and account scopes before a request starts", async () => {
  await prepare();
  fake.target = {
    account: ["https://accounts.example.test", "other-owner"],
    target: { workspaceId: "workspace-b", bindingVersion: 2 },
  };
  const id = send();
  await vi.waitFor(() => expect(fake.reply).toHaveBeenCalledWith(id, expect.any(String), 401, ""));
  expect(fake.fetch).not.toHaveBeenCalled();
});

it("lets only the owning wrapper answer a request from the same native module", async () => {
  const prepareTransport = await prepare();
  await prepareTransport({ ...native }, endpoint, "product-session-fixture", "workspace-a");
  send();
  await vi.waitFor(() => expect(fake.reply).toHaveBeenCalled());
  expect(fake.fetch).toHaveBeenCalledTimes(1);
  expect(fake.reply).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.any(String),
    200,
    '{"json":{"items":[]}}',
  );
});

it("aborts in-flight work and discards late content on logout", async () => {
  await prepare();
  let finish!: (response: Response) => void;
  fake.fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const id = send();
  await vi.waitFor(() => expect(fake.fetch).toHaveBeenCalled());
  const signal = fake.fetch.mock.calls[0]![1]!.signal!;
  fake.generation++;
  fake.clear?.();
  expect(signal.aborted).toBe(true);
  finish(new Response('{"json":{"private":"retired-content"}}'));
  await vi.waitFor(() => expect(fake.reply).toHaveBeenCalledWith(id, expect.any(String), 401, ""));
  expect(JSON.stringify(fake.reply.mock.calls)).not.toContain("retired-content");
  await vi.waitFor(() => expect(fake.reset).toHaveBeenCalledOnce());
});

it("keeps the bridge closed to unrelated RPCs and never relays server error content", async () => {
  await prepare();
  send("models/delete");
  await vi.waitFor(() =>
    expect(fake.reply).toHaveBeenCalledWith(expect.any(String), expect.any(String), 400, ""),
  );
  expect(fake.fetch).not.toHaveBeenCalled();
  fake.fetch.mockResolvedValue(new Response("private-diagnostic", { status: 403 }));
  send();
  await vi.waitFor(() =>
    expect(fake.reply).toHaveBeenCalledWith(expect.any(String), expect.any(String), 403, ""),
  );
  expect(JSON.stringify(fake.reply.mock.calls)).not.toContain("private-diagnostic");
});

it("refuses oversized responses before forwarding any body", async () => {
  await prepare();
  fake.fetch.mockResolvedValue(
    new Response("private-content", {
      headers: { "content-length": String(16 * 1024 * 1024 + 1) },
    }),
  );
  send();
  await vi.waitFor(() =>
    expect(fake.reply).toHaveBeenCalledWith(expect.any(String), expect.any(String), 503, ""),
  );
});

it("ends a stalled request before the native receiver deadline", async () => {
  vi.useFakeTimers();
  try {
    await prepare();
    fake.fetch.mockImplementation(() => new Promise(() => {}));
    send();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fake.reply).toHaveBeenCalledWith(expect.any(String), expect.any(String), 503, "");
  } finally {
    vi.useRealTimers();
  }
});

it("does not acknowledge a registration that completed after a scope change", async () => {
  let finish!: () => void;
  fake.configure.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = prepare();
  await vi.waitFor(() => expect(fake.configure).toHaveBeenCalled());
  fake.generation++;
  finish();
  await expect(pending).rejects.toThrow("Native connection changed");
});

it("requires the updated native bridge for managed targets and leaves ordinary endpoints unchanged", async () => {
  const { prepareNotificationTransport } = await import("./notification-transport");
  await expect(
    prepareNotificationTransport({}, endpoint, "product-session-fixture", "workspace-a"),
  ).rejects.toThrow("Update Ork");
  fake.target = undefined;
  await expect(
    prepareNotificationTransport(
      {},
      "https://server.example.test",
      "product-session-fixture",
      "workspace-a",
    ),
  ).resolves.toBeUndefined();
  expect(fake.fetch).not.toHaveBeenCalled();
});
