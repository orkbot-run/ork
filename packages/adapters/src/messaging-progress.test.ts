// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { JobPublisher, MessagingSurface } from "@orkbot/adapter-kit";
import type * as Database from "@orkbot/db";
import type { PrismaClient } from "@orkbot/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";

const mocks = vi.hoisted(() => ({
  persist: vi.fn(),
  append: vi.fn(),
  progress: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@orkbot/db", async (original) => ({
  ...(await original<typeof Database>()),
  createThreadMessageInTransaction: mocks.persist,
  appendEventInTransaction: mocks.append,
}));
vi.mock("@orkbot/logging", () => ({ getLogger: () => ({ error: mocks.error }) }));
vi.mock("./messaging-delivery.js", () => ({ mirrorMessagingProgress: mocks.progress }));

import { createMessagingContextLoader } from "./messaging-context.js";
import { publishMessage } from "./run-messages.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const run = {
  id: "run-fixture",
  threadId: "thread-fixture",
  botId: "bot-fixture",
  spaceId: "space-fixture",
  trigger: "messaging",
};
const text = [{ kind: "text" as const, text: "Durable progress" }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue({ id: "message-fixture" });
  mocks.append.mockResolvedValue({ seq: 2 });
});

describe("durable progress admission", () => {
  it("starts after commit while realtime notification and provider admission can remain pending", async () => {
    const commit = deferred<void>();
    const notification = deferred<void>();
    const admission = deferred<void>();
    const publishProgress = vi.fn(() => admission.promise);
    const deps = {
      prisma: {
        $transaction: async (body: (tx: object) => Promise<unknown>) => {
          const result = await body({});
          await commit.promise;
          return result;
        },
      },
      messaging: { publishProgress },
      events: { notify: () => notification.promise },
    } as unknown as ExecutorDeps;
    const publishing = publishMessage(deps, run, "bot", text);
    await vi.waitFor(() => expect(mocks.persist).toHaveBeenCalledOnce());
    expect(publishProgress).not.toHaveBeenCalled();
    commit.resolve();
    await vi.waitFor(() => expect(publishProgress).toHaveBeenCalledWith(run.id));
    notification.resolve();
    await expect(publishing).resolves.toMatchObject({ id: "message-fixture" });
    admission.resolve();
  });

  it("does not admit a rolled-back or superseded history write", async () => {
    const publishProgress = vi.fn();
    const stale = new Error("retired lease");
    const deps = {
      prisma: { $transaction: vi.fn().mockRejectedValue(stale) },
      messaging: { publishProgress },
    } as unknown as ExecutorDeps;
    await expect(publishMessage(deps, run, "bot", text)).rejects.toBe(stale);
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it.each(["user", "routine", "call"])("does not admit app-only %s runs", async (trigger) => {
    const publishProgress = vi.fn();
    const deps = {
      prisma: { $transaction: async (body: (tx: object) => Promise<unknown>) => body({}) },
      messaging: { publishProgress },
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ExecutorDeps;
    await publishMessage(deps, { ...run, trigger }, "bot", text);
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it.each(["user", "system"] as const)("does not admit a %s message", async (role) => {
    const publishProgress = vi.fn();
    const deps = {
      prisma: { $transaction: async (body: (tx: object) => Promise<unknown>) => body({}) },
      messaging: { publishProgress },
      events: { notify: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ExecutorDeps;
    await publishMessage(deps, run, role, text);
    expect(publishProgress).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps a committed message usable if optional admission throws (async=%s)",
    async (asynchronous) => {
      const failure = new Error("fixture admission failed");
      const publishProgress = vi.fn(() => {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      });
      const deps = {
        prisma: { $transaction: async (body: (tx: object) => Promise<unknown>) => body({}) },
        messaging: { publishProgress },
        events: { notify: vi.fn().mockResolvedValue(undefined) },
      } as unknown as ExecutorDeps;
      await expect(publishMessage(deps, run, "bot", text)).resolves.toMatchObject({
        id: "message-fixture",
      });
      await vi.waitFor(() =>
        expect(mocks.error).toHaveBeenCalledWith("messaging progress admission", failure),
      );
    },
  );

  it("adds no progress lookup or dispatch when delivery is not configured", () => {
    const findUnique = vi.fn();
    const loader = createMessagingContextLoader({
      messagingIdentity: { findUnique },
    } as unknown as PrismaClient);
    expect(loader).not.toHaveProperty("publishProgress");
    expect(findUnique).not.toHaveBeenCalled();
    expect(mocks.progress).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "wakes the existing drain only after eligible rows were admitted (%s)",
    async (eligible) => {
      mocks.progress.mockResolvedValue(eligible);
      const prisma = {} as PrismaClient;
      const messaging = {} as MessagingSurface;
      const enqueue = vi.fn().mockResolvedValue(undefined);
      const loader = createMessagingContextLoader(prisma, {
        messaging,
        jobs: { enqueue } as unknown as JobPublisher,
      });
      await loader.publishProgress!(run.id);
      expect(mocks.progress).toHaveBeenCalledWith({ prisma, messaging }, run.id);
      if (eligible)
        expect(enqueue).toHaveBeenCalledWith(
          expect.objectContaining({ name: "messaging.deliver", payload: {} }),
        );
      else expect(enqueue).not.toHaveBeenCalled();
    },
  );
});
