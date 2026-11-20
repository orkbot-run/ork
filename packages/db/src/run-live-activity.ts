// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { BotLiveActivity } from "@orkbot/contracts";
import { truncatePlainText } from "@orkbot/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { primaryActiveRun } from "./thread-listing.js";

type ActiveRun = { id: string; status: string; threadId: string };

/** Only the current private-chat run contributes activity to its bot's roster row. */
export async function threadLiveActivities(
  prisma: Pick<PrismaClient, "$queryRaw">,
  threads: readonly { threadId: string | undefined; runs: readonly ActiveRun[] }[],
): Promise<Map<string, BotLiveActivity>> {
  const running = new Map<string, string>();
  for (const { threadId, runs } of threads) {
    if (!threadId) continue;
    const run = primaryActiveRun(runs.filter((candidate) => candidate.threadId === threadId));
    if (run?.status === "running") running.set(run.id, threadId);
  }
  const activities = new Map<string, BotLiveActivity>();
  if (running.size === 0) return activities;

  // Keep the newest progress even when it clears a step or carries no displayable text.
  // The (runId, type, seq) index bounds each lateral read to one row.
  const loaded = await prisma.$queryRaw<
    Array<{ id: string; runId: string; threadId: string; spaceId: string; payload: unknown }>
  >(Prisma.sql`
    SELECT e.id, e."runId", e."threadId", e."spaceId", e.payload
    FROM unnest(${[...running.keys()]}::text[], ${[...running.values()]}::text[]) AS r(id, "threadId")
    CROSS JOIN LATERAL (
      SELECT id, "runId", "threadId", "spaceId", payload
      FROM events
      WHERE "runId" = r.id AND "threadId" = r."threadId" AND type = 'thread.progress'
      ORDER BY seq DESC
      LIMIT 1
    ) e
  `);
  const opened = (await contentEncryptionOf(prisma)?.openRows("Event", loaded)) ?? loaded;
  for (const event of opened) {
    if (running.get(event.runId) !== event.threadId) continue;
    const activity = progressActivity(event.payload);
    if (activity) activities.set(event.threadId, activity);
  }
  return activities;
}

function progressActivity(value: unknown): BotLiveActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  const raw = typeof payload.text === "string" ? payload.text : payload.delta;
  if (typeof raw !== "string") return undefined;
  if (payload.activity === true) {
    const text = raw.trim().replace(/\s+/g, " ");
    return text ? { kind: "step", text: truncatePlainText(text, 120) } : undefined;
  }
  return payload.streaming === true && raw ? { kind: "writing" } : undefined;
}
