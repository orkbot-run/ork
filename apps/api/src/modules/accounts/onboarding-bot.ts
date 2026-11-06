// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor, Bot } from "@orkbot/contracts";
import type { createRepos, PrismaClient } from "@orkbot/db";
import { ensureFirstOrk } from "./first-ork.js";

type Repos = Pick<ReturnType<typeof createRepos>, "createBot" | "listBots">;

/** Keep the personal Ork account-scoped while onboarding other Spaces with an ordinary bot. */
export async function ensureOnboardingBot(
  prisma: PrismaClient,
  repos: Repos,
  actor: Actor,
  ready: boolean,
): Promise<Bot | null> {
  if (!ready) return null;
  const space = await prisma.space.findFirst({
    where: { id: actor.spaceId },
    select: { isDefault: true, organization: { select: { slug: true } } },
  });
  if (!space) return null;
  if (space.isDefault && space.organization.slug === `user-${actor.userId.slice(0, 12)}`) {
    // Null also protects a deleted personal Ork or an account with prior content.
    return ensureFirstOrk(prisma, repos, actor, ready);
  }
  const existing = await prisma.bot.findFirst({
    where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) return (await repos.listBots(actor)).find((bot) => bot.id === existing.id) ?? null;
  const priorContent = await Promise.all([
    prisma.bot.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: { not: null } },
      select: { id: true },
    }),
    prisma.botDeletion.findFirst({
      where: { spaceId: actor.spaceId, deletedByUserId: actor.userId },
      select: { id: true },
    }),
  ]);
  // Reopening a Space after its last bot was removed must keep it empty.
  if (priorContent.some(Boolean)) return null;
  return repos.createBot(actor, {
    name: "Chief",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    spawnKey: `onboarding:space-first:${actor.userId}`,
  });
}
