// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited identity lookup is Apache-covered; Ork adds durable progress admission.

import type { JobPublisher, MessagingSurface } from "@orkbot/adapter-kit";
import { messagingDeliverJob } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { mirrorMessagingProgress } from "./messaging-delivery.js";

/**
 * Executor dep answering whether this bot belongs to a messaging identity:
 * one indexed query per run, and none when the messaging surface is absent.
 */
export function createMessagingContextLoader(
  prisma: PrismaClient,
  delivery?: { messaging: MessagingSurface; jobs: JobPublisher },
) {
  return {
    hasIdentity: async (botId: string): Promise<boolean> =>
      Boolean(
        await prisma.messagingIdentity.findUnique({ where: { botId }, select: { id: true } }),
      ),
    ...(delivery
      ? {
          publishProgress: async (runId: string): Promise<void> => {
            if (await mirrorMessagingProgress({ prisma, messaging: delivery.messaging }, runId))
              await delivery.jobs.enqueue(messagingDeliverJob());
          },
        }
      : {}),
  };
}
