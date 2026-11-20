import { runContinueJob } from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { startNextWaitingRun } from "./run-lifecycle.js";

function deps(next: { id: string } | null, scheduled: { id: string } | null = null) {
  const findFirst = vi.fn(async () => next).mockResolvedValueOnce(scheduled);
  const enqueue = vi.fn(async () => undefined);
  return {
    deps: { prisma: { run: { findFirst } }, jobs: { enqueue } } as unknown as ExecutorDeps,
    findFirst,
    enqueue,
  };
}

describe("starting the next run waiting for a bot's computer", () => {
  it("starts the oldest other due run of the bot, leaving failure backoff alone", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z") });
    try {
      const f = deps({ id: "waiting" });
      await startNextWaitingRun(f.deps, "bot", "finished", "thread");
      expect(f.findFirst).toHaveBeenCalledWith({
        where: {
          botId: "bot",
          status: "queued",
          id: { not: "finished" },
          OR: [{ wakeAt: null }, { wakeAt: { lte: new Date("2026-10-28T12:00:00Z") } }],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("waiting"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("wakes a due routine from the completed conversation before work in other threads", async () => {
    const f = deps({ id: "another-thread" }, { id: "routine" });
    await startNextWaitingRun(f.deps, "bot", "finished", "thread");
    expect(f.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        botId: "bot",
        threadId: "thread",
        id: { not: "finished" },
        status: "queued",
        AND: [
          {
            trigger: "routine",
            OR: [
              { clientNonce: { startsWith: "routine-timer:" } },
              { clientNonce: { startsWith: "routine-schedule:" } },
            ],
          },
          { OR: [{ wakeAt: null }, { wakeAt: { lte: expect.any(Date) } }] },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(runContinueJob("routine"));
  });

  it("does nothing when no run is waiting", async () => {
    const f = deps(null);
    await startNextWaitingRun(f.deps, "bot", "finished", "thread");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
