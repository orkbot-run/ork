// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import {
  asSystem,
  createDb,
  finalizeRun,
  provisionMessagingIdentity,
  ROUTINE_SCHEDULE_NONCE_PREFIX,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRoutineRuns } from "./routine-runs.js";
import { listRoutinesDto } from "./routines.js";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

postgres("one-shot routine completion (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let actor: Actor;
  let scope: { spaceId: string; userId: string; botId: string; threadId: string };
  const address = `one-shot-${randomUUID()}@orkbot.test`;

  beforeAll(async () => {
    db = createDb(url!);
    const { userId, spaceId, botId, threadId } = await runAsSystem("one-shot fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        {
          signupsEnabled: undefined,
          signupAllowlist: undefined,
        },
      ),
    );
    scope = { spaceId, userId, botId, threadId };
    actor = { spaceId, userId, email: address, isDeploymentOwner: false };
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (scope) {
        const system = asSystem(db.prisma);
        await system.messagingIdentity.deleteMany({ where: { address } });
        await system.organization.deleteMany({ where: { id: scope.spaceId } });
        await system.user.deleteMany({ where: { id: scope.userId } });
      }
    } finally {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  async function execute(
    routineId: string,
    kind: "scheduled" | "manual" | "retry",
    outcome: "completed" | "failed",
    retryOfRunId?: string,
  ) {
    const now = new Date();
    const task = await db.prisma.task.create({
      data: { ...scope, prompt: "Fixture", status: "running" },
    });
    const run = await db.prisma.run.create({
      data: {
        ...scope,
        routineId,
        taskId: task.id,
        trigger: "routine",
        status: "running",
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        startedAt: now,
        clientNonce:
          kind === "scheduled"
            ? `${ROUTINE_SCHEDULE_NONCE_PREFIX}${routineId}:${now.toISOString()}`
            : kind === "manual"
              ? `routine-run:${scope.userId}:${randomUUID()}`
              : null,
        retryOfRunId,
      },
    });
    const attempt = await db.prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const result = await finalizeRun(db.prisma, {
      ...scope,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "fixture-worker",
      leaseFence: 1,
      ...(outcome === "completed"
        ? { outcome, blocks: [], retireOneShotRoutine: true }
        : { outcome, error: "Fixture failure" }),
    });
    expect(result).not.toBe(false);
    return run;
  }

  it.each(["scheduled", "retry", "failed", "manual"] as const)(
    "handles %s one-shot history and visibility",
    async (kind) => {
      await runAsTenant(scope, async () => {
        const routine = await db.prisma.routine.create({
          data: {
            ...scope,
            name: "Reminder",
            prompt: "Notify",
            crons: ["@once"],
            active: false,
            lastRunAt: new Date(),
          },
        });
        const first = await execute(
          routine.id,
          kind === "manual" ? "manual" : "scheduled",
          kind === "failed" || kind === "retry" ? "failed" : "completed",
        );
        if (kind === "retry") await execute(routine.id, "retry", "completed", first.id);
        const shouldHide = kind === "scheduled" || kind === "retry";
        const saved = await db.prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
        expect(saved.completedOneShotAt !== null).toBe(shouldHide);
        const visible = await listRoutinesDto(
          { prisma: db.prisma } as Parameters<typeof listRoutinesDto>[0],
          actor,
          scope.botId,
        );
        expect(visible.some((row) => row.id === routine.id)).toBe(!shouldHide);
        const history = await listRoutineRuns(db.prisma, actor, routine.id);
        expect(history.runs.map((run) => run.id)).toContain(first.id);
        expect(history.runs).toHaveLength(kind === "retry" ? 2 : 1);
      });
    },
  );
});
