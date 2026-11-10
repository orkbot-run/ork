// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "./client.js";

/** Fetch one user's snooze state for an already-authorized thread set. */
export async function loadThreadSnoozes(prisma: PrismaClient, userId: string, threadIds: string[]) {
  if (threadIds.length === 0) return new Map<string, string>();
  const rows = await prisma.threadSnooze.findMany({
    where: { userId, threadId: { in: threadIds }, until: { not: null } },
    select: { threadId: true, until: true },
  });
  return new Map(
    rows.flatMap((row) => (row.until ? [[row.threadId, row.until.toISOString()] as const] : [])),
  );
}
