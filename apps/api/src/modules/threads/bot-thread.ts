import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { IsolationError } from "@orkbot/db";

export type BotThreadDeps = {
  prisma: PrismaClient;
};

export async function requireBotThread(deps: BotThreadDeps, actor: Actor, botId: string) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
    include: { thread: true },
  });
  if (!bot?.thread) throw new IsolationError();
  return { bot, thread: bot.thread };
}
