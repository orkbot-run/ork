// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor, Bot } from "@orkbot/contracts";
import { parseBotAvatarValue } from "@orkbot/contracts";
import { isPersonalOrkId, seededLogoAvatarColor } from "@orkbot/core";
import type { createRepos, Prisma, PrismaClient } from "@orkbot/db";
import { FirstBotAlreadyExistsError } from "@orkbot/db";

type Repos = Pick<ReturnType<typeof createRepos>, "createBot" | "listBots">;

function primaryWhere(actor: Actor): Prisma.BotWhereInput {
  return {
    userId: actor.userId,
    spaceId: actor.spaceId,
    archivedAt: null,
    OR: [
      { spawnKey: { in: [`onboarding:first:${actor.userId}`, "onboarding:first"] } },
      {
        spawnKey: null,
        name: "Chief",
        position: 0,
        parentBotId: null,
        space: { isDefault: true, organization: { slug: `user-${actor.userId.slice(0, 12)}` } },
      },
    ],
  };
}

/** Provision only in the account's original workspace, never in an arbitrary empty Space. */
export async function ensureFirstOrk(
  prisma: PrismaClient,
  repos: Repos,
  actor: Actor,
  ready: boolean,
): Promise<Bot | null> {
  if (!ready) return null;
  const space = await prisma.space.findFirst({
    where: {
      id: actor.spaceId,
      isDefault: true,
      organization: { slug: `user-${actor.userId.slice(0, 12)}` },
    },
    select: { id: true },
  });
  if (!space) return null;
  const spawnKey = `onboarding:first:${actor.userId}`;
  const [user, existing] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { orkAvatar: true } }),
    prisma.bot.findFirst({
      where: primaryWhere(actor),
      select: { id: true, avatarSeed: true, color: true, fleetManagement: true },
    }),
  ]);
  const avatarSeed = isPersonalOrkId(user.orkAvatar) ? user.orkAvatar : undefined;
  if (existing) {
    if (avatarSeed) await syncPrimaryAppearance(prisma, actor, existing, avatarSeed);
    return (await repos.listBots(actor)).find((bot) => bot.id === existing.id) ?? null;
  }
  try {
    return await repos.createBot(actor, {
      name: "Chief",
      description: "",
      instructions: "",
      notifyOnFinish: true,
      fleetManagement: true,
      spawnKey,
      firstForAccount: true,
      ...(avatarSeed ? { avatarSeed, color: seededLogoAvatarColor(avatarSeed) } : {}),
    });
  } catch (error) {
    if (!(error instanceof FirstBotAlreadyExistsError)) throw error;
    // Another device may have committed the primary bot while this call waited on its owner.
    const winner = await prisma.bot.findFirst({
      where: { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null, spawnKey },
      select: { id: true },
    });
    return winner
      ? ((await repos.listBots(actor)).find((bot) => bot.id === winner.id) ?? null)
      : null;
  }
}

type Primary = { id: string; avatarSeed: string | null; color: string; fleetManagement: boolean };

async function syncPrimaryAppearance(
  prisma: PrismaClient,
  actor: Actor,
  bot: Primary,
  seed: string,
) {
  if (bot.avatarSeed) return;
  const avatar = parseBotAvatarValue(bot.color);
  const customAppearance = avatar.kind === "image" || avatar.kind === "shape";
  // Preserve an explicit colour choice; replace only the old automatically generated colour.
  const color =
    bot.color.toUpperCase() === seededLogoAvatarColor(bot.id).toUpperCase()
      ? seededLogoAvatarColor(seed)
      : bot.color;
  await prisma.bot.updateMany({
    where: {
      id: bot.id,
      userId: actor.userId,
      spaceId: actor.spaceId,
      avatarSeed: bot.avatarSeed,
      color: bot.color,
    },
    data: { fleetManagement: true, avatarSeed: seed, ...(!customAppearance ? { color } : {}) },
  });
}

/** Existing accounts adopt their saved Ork on profile reads, without creating any agent. */
export async function syncPrimaryOrk(
  prisma: PrismaClient,
  actor: Actor,
  seed: unknown,
): Promise<void> {
  if (!isPersonalOrkId(seed)) return;
  const bot = await prisma.bot.findFirst({
    where: { ...primaryWhere(actor), avatarSeed: null },
    select: { id: true, avatarSeed: true, color: true, fleetManagement: true },
    orderBy: { createdAt: "asc" },
  });
  if (bot) await syncPrimaryAppearance(prisma, actor, bot, seed);
}
