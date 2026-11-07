// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor } from "@orkbot/contracts";
import { createRouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter, HEARTBEAT_MS, SESSION_RECHECK_MS } from "./router.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: true,
};
const kinds = ["threads", "boards", "alerts", "calls"] as const;
type Kind = (typeof kinds)[number];
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function fixture(kind: Kind) {
  const controller = new AbortController();
  const stillAuthorized = vi.fn(async () => true);
  let sourceSignal: AbortSignal | undefined;
  const source = {
    next: vi.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
    return: vi.fn(() => new Promise<IteratorResult<unknown>>(() => {})),
  };
  const follow = (...args: unknown[]) => {
    sourceSignal = args.at(-1) as AbortSignal;
    return source;
  };
  const router = createRouter({
    prisma: {
      bot: {
        findFirst: vi.fn(async () => ({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        })),
      },
    },
    env: { ticketBoardEnabled: true, phoneCallsEnabled: true },
    events: { follow, followChatAlerts: follow, followIncomingCalls: follow },
    boardEvents: { follow },
  } as unknown as RouterDeps);
  const client = createRouterClient(router, {
    context: { actor, signal: controller.signal, stillAuthorized },
  });
  async function open() {
    if (kind === "threads") return client.threads.subscribe({ botId: "bot-1", cursor: 0 });
    if (kind === "boards") return client.boards.subscribe();
    if (kind === "alerts") return client.notifications.subscribe();
    return client.notifications.subscribeCalls();
  }
  return { controller, stillAuthorized, source, router, open, signal: () => sourceSignal };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(kinds)("aborts %s immediately despite a blocked source next and return", async (kind) => {
  const h = fixture(kind);
  const iterator = await h.open();
  let outcome = "pending";
  const next = iterator.next().then(
    () => {
      outcome = "done";
    },
    () => {
      outcome = "error";
    },
  );
  await flush();
  expect(h.source.next).toHaveBeenCalledOnce();
  h.controller.abort();
  await flush();
  expect(outcome).toBe("done");
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await next;
});

it.each(kinds)("revokes %s while next and return remain blocked", async (kind) => {
  const h = fixture(kind);
  h.stillAuthorized.mockResolvedValue(false);
  const iterator = await h.open();
  let failure: unknown;
  const next = iterator.next().catch((error: unknown) => {
    failure = error;
  });
  await flush();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  await flush();
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({ code: "UNAUTHORIZED" });
  expect(h.stillAuthorized).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await next;
});

it.each(kinds)(
  "closes %s through explicit return without waiting behind pending next",
  async (kind) => {
    const h = fixture(kind);
    const iterator = await h.open();
    let done = false;
    let returned = false;
    const next = iterator.next().then(() => {
      done = true;
    });
    await flush();
    const closing = iterator.return?.().then(() => {
      returned = true;
    });
    await flush();
    expect(done).toBe(true);
    expect(returned).toBe(true);
    expect(h.signal()?.aborted).toBe(true);
    expect(h.source.return).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all([next, closing]);
  },
);

it.each(kinds)("aborts %s without waiting for a blocked session recheck", async (kind) => {
  const h = fixture(kind);
  h.stillAuthorized.mockImplementation(() => new Promise<boolean>(() => {}));
  const iterator = await h.open();
  let done = false;
  const next = iterator.next().then(() => {
    done = true;
  });
  await flush();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
  expect(h.stillAuthorized).toHaveBeenCalledOnce();
  h.controller.abort();
  await flush();
  expect(done).toBe(true);
  expect(h.signal()?.aborted).toBe(true);
  expect(h.source.return).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  await next;
});

it.each(kinds)(
  "rechecks idle %s at the session deadline without adding a wire frame",
  async (kind) => {
    const h = fixture(kind);
    const iterator = await h.open();
    let delivered = false;
    const next = iterator.next().then(() => {
      delivered = true;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
    expect(h.stillAuthorized).toHaveBeenCalledOnce();
    expect(delivered).toBe(false);
    h.controller.abort();
    await flush();
    await next;
  },
);

it.each(kinds)("preserves the exact %s heartbeat payload and20-second cadence", async (kind) => {
  const h = fixture(kind);
  const iterator = await h.open();
  const next = iterator.next();
  let delivered = false;
  void next.then(() => {
    delivered = true;
  });
  await flush();
  await vi.advanceTimersByTimeAsync(SESSION_RECHECK_MS);
  expect(delivered).toBe(false);
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - SESSION_RECHECK_MS);
  const frame = (await next).value;
  if (kind === "threads")
    expect(frame).toEqual({
      id: "heartbeat",
      spaceId: actor.spaceId,
      threadId: "thread-1",
      botId: "bot-1",
      seq: 0,
      type: "heartbeat",
      createdAt: new Date().toISOString(),
      payload: {},
    });
  else if (kind === "boards")
    expect(frame).toEqual({ spaceId: actor.spaceId, createdAt: new Date().toISOString() });
  else expect(frame).toEqual({ type: "heartbeat" });
  expect(h.source.next).toHaveBeenCalledOnce();
  await iterator.return?.();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a board change signal without adding heartbeat fields", async () => {
  const h = fixture("boards");
  const changed = {
    spaceId: actor.spaceId,
    createdAt: new Date().toISOString(),
    ticketId: "ticket-1",
    boardId: "board-1",
  };
  h.source.next.mockResolvedValueOnce({ done: false, value: changed });
  const iterator = await h.open();
  expect((await iterator.next()).value).toEqual(changed);
  await iterator.return?.();
});

it.each(kinds)(
  "cancels the actual %s SSE response while source next and return are blocked",
  async (kind) => {
    const h = fixture(kind);
    const endpoint =
      kind === "threads"
        ? "threads/subscribe"
        : kind === "boards"
          ? "boards/subscribe"
          : kind === "alerts"
            ? "notifications/subscribe"
            : "notifications/subscribeCalls";
    const { response } = await new RPCHandler(h.router).handle(
      new Request(`http://localhost/rpc/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: kind === "threads" ? { botId: "bot-1", cursor: 0 } : undefined,
        }),
      }),
      { prefix: "/rpc", context: { actor, stillAuthorized: h.stillAuthorized } },
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const reader = response!.body!.getReader();
    // The RPC transport opens SSE with its own comment, before any application frame.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": \n\n");
    const next = reader.read();
    await flush();
    expect(h.source.next).toHaveBeenCalledOnce();
    let cancelled = false;
    const cancellation = reader.cancel().then(() => {
      cancelled = true;
    });
    await flush();
    expect(cancelled).toBe(true);
    expect(h.signal()?.aborted).toBe(true);
    expect(h.source.return).toHaveBeenCalledOnce();
    expect(await next).toEqual({ done: true, value: undefined });
    await cancellation;
    expect(vi.getTimerCount()).toBe(0);
  },
);
