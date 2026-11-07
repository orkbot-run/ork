// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited material remains Apache-2.0; Ork deferred messaging SDK loading is PolyForm-covered.

import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingInstallation,
  MessagingInstallationStore,
  MessagingInstallProvider,
  MessagingSurface,
} from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { InstalledMessagingSurface } from "./installed-messaging-surface.js";

const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  userId: "user-a",
  spaceId: "space-a",
  signal: new AbortController().signal,
};
const inbound: MessagingInboundMessage = {
  type: "message",
  provider: "slack",
  handle: "1.001",
  threadId: "slack:C1:1.001",
  isDirect: true,
  from: "U1",
  fromLabel: "Sender",
  content: "hello",
  mediaUrl: null,
  participants: [],
  channelName: null,
};
function fixture() {
  const installations = new Map<string, MessagingInstallation>(
    ["a", "b"].map((id) => [
      id,
      {
        id,
        provider: "slack",
        workspaceId: `T${id}`,
        workspaceName: id,
        spaceId: `space-${id}`,
        userId: `user-${id}`,
        botId: `bot-${id}`,
        credential: `token-${id}`,
      },
    ]),
  );
  const store: MessagingInstallationStore = {
    get: vi.fn(
      async (provider, workspaceId) =>
        [...installations.values()].find(
          (row) => row.provider === provider && row.workspaceId === workspaceId,
        ) ?? null,
    ),
    getById: vi.fn(async (id) => installations.get(id) ?? null),
    removeWorkspace: vi.fn(async (provider, workspaceId) => {
      for (const [id, row] of installations)
        if (row.provider === provider && row.workspaceId === workspaceId) installations.delete(id);
    }),
  };
  const sends = vi.fn(async (_credential: string, request: unknown) => ({
    handle: "reply",
    request,
  }));
  const receipts = vi.fn(
    async (_credential: string, _threadId: string, _handle: string) => undefined,
  );
  const surfaces = vi.fn((credential: string) => {
    let sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
    return {
      describe: () => ({
        id: "fake",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: ["slack"] },
      }),
      platforms: () => [
        { provider: "slack", capabilities: { direct: true, groups: true, receipt: "reaction" } },
      ],
      onInbound: (callback) => {
        sink = callback;
      },
      handleWebhook: async () => {
        await sink?.(inbound);
        return new Response(null, { status: 200 });
      },
      sendToThread: (request) => sends(credential, request),
      acknowledge: (threadId, handle) => receipts(credential, threadId, handle),
      openDirectThread: async (_provider, address) => `slack:D-${address}`,
      fetchThreadHistory: async () => [inbound],
      shutdown: vi.fn(async () => undefined),
    } as MessagingSurface;
  });
  const provider: MessagingInstallProvider = {
    provider: "slack",
    capabilities: { direct: true, groups: true, receipt: "reaction" },
    surface: surfaces,
    authorizeUrl: (state) => state,
    exchange: vi.fn(),
    parseWebhook: async (request) => ({
      request,
      workspaceId: new URL(request.url).searchParams.get("team") ?? undefined,
    }),
  };
  return {
    messaging: new InstalledMessagingSurface(store, provider),
    installations,
    store,
    provider,
    surfaces,
    sends,
    receipts,
  };
}
const webhook = (team = "Ta") =>
  new Request(`https://app.example.test/webhook?team=${team}`, { method: "POST", body: "{}" });

describe("installed messaging isolation", () => {
  it("namespaces the same Slack user, message and channel separately in each workspace", async () => {
    const f = fixture();
    const events: MessagingInboundEvent[] = [];
    f.messaging.onInbound(async (event) => {
      events.push(event);
    });
    await f.messaging.handleWebhook("slack", webhook("Ta"));
    await f.messaging.handleWebhook("slack", webhook("Tb"));
    expect(events).toMatchObject([
      {
        from: "Ta:U1",
        handle: "Ta:1.001",
        threadId: "slack~a:C1:1.001",
        installationSpaceId: "space-a",
        installationBotId: "bot-a",
      },
      {
        from: "Tb:U1",
        handle: "Tb:1.001",
        threadId: "slack~b:C1:1.001",
        installationSpaceId: "space-b",
        installationBotId: "bot-b",
      },
    ]);
  });

  it("resolves workspace credentials for queued replies, even in a fresh worker", async () => {
    const f = fixture();
    await f.messaging.sendToThread({ threadId: "slack~a:C1:1.001", body: "reply" }, context);
    expect(f.sends).toHaveBeenCalledWith("token-a", { threadId: "slack:C1:1.001", body: "reply" });
    await f.messaging.acknowledge("slack~a:C1:1.001", "Ta:1.001", context);
    expect(f.receipts).toHaveBeenCalledWith("token-a", "slack:C1:1.001", "1.001");
    expect(f.surfaces).toHaveBeenCalledTimes(1);
    await expect(f.messaging.acknowledge("slack~a:C1", "Tb:1.001", context)).rejects.toThrow(
      "another workspace",
    );
  });

  it("rejects cross-space sends and unscoped Slack threads before constructing an adapter", async () => {
    const f = fixture();
    await expect(
      f.messaging.sendToThread({ threadId: "slack~b:C1", body: "secret" }, context),
    ).rejects.toThrow("unavailable");
    await expect(
      f.messaging.sendToThread({ threadId: "slack:C1", body: "secret" }, context),
    ).rejects.toThrow("scoped");
    expect(f.surfaces).not.toHaveBeenCalled();
  });

  it("checks storage on every send so disconnect and token replacement take effect immediately", async () => {
    const f = fixture();
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "first" }, context);
    f.installations.set("a", { ...f.installations.get("a")!, credential: "replacement" });
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "second" }, context);
    expect(f.sends).toHaveBeenLastCalledWith("replacement", expect.anything());
    f.installations.delete("a");
    await expect(
      f.messaging.sendToThread({ threadId: "slack~a:C1", body: "third" }, context),
    ).rejects.toThrow("unavailable");
    expect(f.sends).toHaveBeenCalledTimes(2);
  });

  it("ignores uninstalled workspaces and rejects unsigned webhooks before looking up credentials", async () => {
    const f = fixture();
    await f.messaging.handleWebhook("slack", webhook("unknown"));
    expect(f.surfaces).not.toHaveBeenCalled();
    vi.mocked(f.store.get).mockClear();
    f.provider.parseWebhook = async () => {
      throw new Error("signature");
    };
    expect((await f.messaging.handleWebhook("slack", webhook()))?.status).toBe(401);
    expect(f.store.get).not.toHaveBeenCalled();
  });

  it("accepts the signed verification challenge before any workspace is installed", async () => {
    const f = fixture();
    f.provider.parseWebhook = async (request) => ({ request, challenge: "challenge" });
    expect(await (await f.messaging.handleWebhook("slack", webhook()))?.json()).toEqual({
      challenge: "challenge",
    });
    expect(f.store.get).not.toHaveBeenCalled();
  });

  it("removes only the verified workspace when Slack uninstalls the app", async () => {
    const f = fixture();
    f.provider.parseWebhook = async (request) => ({
      request,
      workspaceId: "Ta",
      uninstalled: true,
    });
    await f.messaging.handleWebhook("slack", webhook());
    expect(f.installations.has("a")).toBe(false);
    expect(f.installations.has("b")).toBe(true);
    expect(f.surfaces).not.toHaveBeenCalled();
  });

  it("opens DMs with a scoped sender and scopes fetched history for the same workspace", async () => {
    const f = fixture();
    expect(await f.messaging.openDirectThread("slack", "Ta:U1", context)).toBe("slack~a:D-U1");
    expect(
      await f.messaging.fetchThreadHistory(
        "slack~a:C1:1.001",
        { before: "Ta:1.001", limit: 10 },
        context,
      ),
    ).toMatchObject([{ from: "Ta:U1", handle: "Ta:1.001", workspaceId: "Ta" }]);
  });
});

it("keeps a new installation separate from retained channel history", async () => {
  const f = fixture();
  const events: MessagingInboundEvent[] = [];
  f.messaging.onInbound(async (event) => {
    events.push(event);
  });
  await f.messaging.handleWebhook("slack", webhook());
  f.installations.delete("a");
  f.installations.set("new", {
    id: "new",
    provider: "slack",
    workspaceId: "Ta",
    workspaceName: "Reinstalled",
    spaceId: "space-new",
    userId: "user-new",
    botId: "bot-new",
    credential: "new-token",
  });
  await f.messaging.handleWebhook("slack", webhook());
  expect(events).toMatchObject([
    { conversationKey: "a:slack:C1:1.001" },
    { conversationKey: "new:slack:C1:1.001", installationSpaceId: "space-new" },
  ]);
});

it("shuts down cached adapters on replacement, removal and process shutdown", async () => {
  const f = fixture();
  await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "first" }, context);
  const original = f.surfaces.mock.results[0]!.value;
  f.installations.set("a", { ...f.installations.get("a")!, credential: "replacement" });
  await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "second" }, context);
  expect(original.shutdown).toHaveBeenCalledTimes(1);
  const replacement = f.surfaces.mock.results[1]!.value;
  await f.messaging.shutdown();
  expect(replacement.shutdown).toHaveBeenCalledTimes(1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ready, failed) => {
    resolve = ready;
    reject = failed;
  });
  return { promise, resolve, reject };
}

it("shares pending surface construction for concurrent deliveries", async () => {
  const f = fixture();
  const surface = f.surfaces("token-a");
  const gate = deferred<MessagingSurface>();
  const started = deferred<void>();
  const construct = vi.fn(() => {
    started.resolve();
    return gate.promise;
  });
  f.provider.surface = construct;
  const sends = ["first", "second"].map((body) =>
    f.messaging.sendToThread({ threadId: "slack~a:C1", body }, context),
  );
  await started.promise;
  expect(construct).toHaveBeenCalledTimes(1);
  expect(f.sends).not.toHaveBeenCalled();
  gate.resolve(surface);
  await Promise.all(sends);
  expect(construct).toHaveBeenCalledTimes(1);
  expect(f.sends).toHaveBeenCalledTimes(2);
  await f.messaging.shutdown();
  expect(surface.shutdown).toHaveBeenCalledTimes(1);
});

it("removes a failed construction so the next delivery can retry", async () => {
  const f = fixture();
  const surface = f.surfaces("token-a");
  const construct = vi
    .fn()
    .mockRejectedValueOnce(new Error("fixture construction failure"))
    .mockResolvedValue(surface);
  f.provider.surface = construct;
  await expect(
    f.messaging.sendToThread({ threadId: "slack~a:C1", body: "first" }, context),
  ).rejects.toThrow("fixture construction failure");
  await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "retry" }, context);
  expect(construct).toHaveBeenCalledTimes(2);
  expect(f.sends).toHaveBeenCalledTimes(1);
  await f.messaging.shutdown();
  expect(surface.shutdown).toHaveBeenCalledTimes(1);
});

it.each(["resolve", "reject"] as const)(
  "keeps a rotated replacement when older pending construction later %ss",
  async (outcome) => {
    const f = fixture();
    const old = f.surfaces("token-a");
    const replacement = f.surfaces("replacement");
    const gate = deferred<MessagingSurface>();
    const started = deferred<void>();
    const construct = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      })
      .mockResolvedValue(replacement);
    f.provider.surface = construct;
    const pending = f.messaging.sendToThread({ threadId: "slack~a:C1", body: "old" }, context);
    const observed = pending.then(
      () => "sent",
      () => "failed",
    );
    await started.promise;
    f.installations.set("a", { ...f.installations.get("a")!, credential: "replacement" });
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "new" }, context);
    if (outcome === "resolve") gate.resolve(old);
    else gate.reject(new Error("fixture old construction failure"));
    expect(await observed).toBe(outcome === "resolve" ? "sent" : "failed");
    await f.messaging.sendToThread({ threadId: "slack~a:C1", body: "still new" }, context);
    expect(construct).toHaveBeenCalledTimes(2);
    expect(old.shutdown).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0);
    expect(replacement.shutdown).not.toHaveBeenCalled();
    expect(f.sends.mock.calls.at(-1)?.[0]).toBe("replacement");
    await f.messaging.shutdown();
    expect(replacement.shutdown).toHaveBeenCalledTimes(1);
  },
);

it("eventually shuts down a pending surface once its admitted users finish", async () => {
  const f = fixture();
  const surface = f.surfaces("token-a");
  const gate = deferred<MessagingSurface>();
  const started = deferred<void>();
  f.provider.surface = vi.fn(() => {
    started.resolve();
    return gate.promise;
  });
  const pending = f.messaging.sendToThread(
    { threadId: "slack~a:C1", body: "already admitted" },
    context,
  );
  await started.promise;
  // Shutdown retains the existing non-draining behavior for active users.
  await f.messaging.shutdown();
  expect(surface.shutdown).not.toHaveBeenCalled();
  gate.resolve(surface);
  await pending;
  expect(surface.shutdown).toHaveBeenCalledTimes(1);
  await f.messaging.shutdown();
  expect(surface.shutdown).toHaveBeenCalledTimes(1);
});
