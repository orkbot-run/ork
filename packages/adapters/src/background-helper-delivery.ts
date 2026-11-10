// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { JobPublisher } from "@orkbot/adapter-kit";
import { runContinueJob } from "@orkbot/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@orkbot/db";
import { returnBackgroundHelperOutcome } from "@orkbot/db";
import { getLogger } from "@orkbot/logging";

/** Deliver a committed result; durable run recovery repairs a missed job wake-up. */
export async function deliverBackgroundHelperOutcome(
  deps: { prisma: PrismaClient; events: ThreadEvents; jobs: JobPublisher },
  input: { spaceId: string; runId: string },
) {
  const result = await returnBackgroundHelperOutcome(deps.prisma, input);
  if (!result) return;
  await deps.events.notify(result.threadId, result.eventSeq).catch((error) => {
    getLogger().error("background helper result notification", error);
  });
  if (result.wakeRunId) {
    await deps.jobs.enqueue(runContinueJob(result.wakeRunId)).catch((error) => {
      getLogger().error("background helper result wake-up", error);
    });
  }
}
