// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited bot communication checks remain Apache-2.0. Ork adds the central workspace boundary.

import type { Prisma, PrismaClient } from "./client.js";

/** Call within the delivery transaction to serialize against disabling either bot. */
export async function crossSpaceCommunicationAllowed(
  prisma: Pick<PrismaClient | Prisma.TransactionClient, "$queryRaw">,
  senderBotId: string,
  targetBotId: string,
): Promise<boolean> {
  const bots = await prisma.$queryRaw<
    Array<{
      id: string;
      spaceId: string;
      crossSpaceCommunication: boolean;
      archivedAt: Date | null;
      centralized: boolean;
    }>
  >`
    SELECT bot.id, bot."spaceId", bot."crossSpaceCommunication", bot."archivedAt",
      EXISTS (SELECT 1 FROM public.central_workspace_bindings binding WHERE binding."spaceId" = bot."spaceId") AS centralized
    FROM bots bot WHERE bot.id = ${senderBotId} OR bot.id = ${targetBotId}
    ORDER BY bot.id FOR NO KEY UPDATE OF bot
  `;
  if (bots.length !== 2 || bots.some((bot) => bot.archivedAt)) return false;
  return (
    bots[0]!.spaceId === bots[1]!.spaceId ||
    (bots.every((bot) => !bot.centralized) &&
      bots.every((bot) => bot.crossSpaceCommunication === true))
  );
}

export class CrossSpaceCommunicationBlockedError extends Error {
  constructor() {
    super("Cross-space bot communication is disabled.");
    this.name = "CrossSpaceCommunicationBlockedError";
  }
}
