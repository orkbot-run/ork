// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/prisma/client.js";

export const SERVER_UPDATE_COOLDOWN_MS = 60 * 60 * 1000;
export const SERVER_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export class ServerUpdateConflict extends Error {}
export interface ServerUpdateBinding {
  installationId: string;
  delegatedAccountKey: string;
  channel: "stable" | "preview";
  currentRevision: string | null;
}

/** Call within runAsSystem; the records are installation-owned, never tenant-authorized. */
export function serverUpdateStore(prisma: PrismaClient, binding: ServerUpdateBinding) {
  const where = { id: binding.installationId };
  const bound = {
    ...where,
    delegatedAccountKey: binding.delegatedAccountKey,
    channel: binding.channel,
  };
  return {
    async ensure() {
      const control = await prisma.serverUpdateControl.upsert({
        where,
        create: { ...bound },
        update: {},
      });
      if (
        control.delegatedAccountKey !== binding.delegatedAccountKey ||
        control.channel !== binding.channel
      )
        throw new ServerUpdateConflict("The operator binding changed");
      return control;
    },
    control: () => prisma.serverUpdateControl.findUniqueOrThrow({ where }),
    latest: () =>
      prisma.serverUpdateRequest.findFirst({
        where: { installationId: binding.installationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    async recover() {
      await prisma.serverUpdateRequest.updateMany({
        where: {
          installationId: binding.installationId,
          state: { in: ["queued", "submitting"] },
          updatedAt: { lt: new Date(Date.now() - 60_000) },
        },
        data: { state: "unknown" },
      });
    },
    async claimCheck(automatic: boolean, ownerUserId?: string) {
      if (automatic && !ownerUserId) return null;
      const token = randomUUID();
      const claimed = await prisma.serverUpdateControl.updateMany({
        where: {
          ...bound,
          ...(automatic
            ? {
                automatic: true,
                consentedAccountKey: binding.delegatedAccountKey,
                consentedUserId: ownerUserId,
                nextCheckAt: { lte: new Date() },
              }
            : {}),
          AND: [
            { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: new Date() } }] },
            ...(automatic
              ? []
              : [
                  {
                    OR: [
                      { lastCheckedAt: null },
                      { lastCheckedAt: { lt: new Date(Date.now() - 60_000) } },
                    ],
                  },
                ]),
          ],
        },
        data: {
          leaseToken: token,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          nextCheckAt: new Date(Date.now() + SERVER_UPDATE_CHECK_INTERVAL_MS),
        },
      });
      return claimed.count === 1 ? token : null;
    },
    async finishCheck(
      token: string,
      candidate: { revision: string; version: string } | null,
      failed: boolean,
    ) {
      return (
        (
          await prisma.serverUpdateControl.updateMany({
            where: { ...bound, leaseToken: token, leaseExpiresAt: { gt: new Date() } },
            data: {
              candidateBaseRevision: binding.currentRevision,
              candidateRevision: candidate?.revision ?? null,
              candidateVersion: candidate?.version ?? null,
              lastCheckedAt: new Date(),
              checkFailed: failed,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          })
        ).count === 1
      );
    },
    async policy(automatic: boolean, expectedRevision: number, userId: string) {
      const changed = await prisma.serverUpdateControl.updateMany({
        where: { ...bound, policyRevision: expectedRevision },
        data: {
          automatic,
          consentedAccountKey: automatic ? binding.delegatedAccountKey : null,
          consentedUserId: automatic ? userId : null,
          policyRevision: { increment: 1 },
          nextCheckAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new ServerUpdateConflict("The update policy changed");
    },
    async queue(
      input: { revision: string; idempotencyKey: string } & (
        | { automatic: false }
        | { automatic: true; policyRevision: number; ownerUserId: string }
      ),
    ) {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`server-updates:${binding.installationId}`}))`;
        const existing = await tx.serverUpdateRequest.findUnique({
          where: {
            installationId_idempotencyKey: {
              installationId: binding.installationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) {
          if (existing.revision !== input.revision)
            throw new ServerUpdateConflict("The request key was already used");
          return { request: existing, created: false };
        }
        const control = await tx.serverUpdateControl.findUniqueOrThrow({ where });
        if (
          control.delegatedAccountKey !== binding.delegatedAccountKey ||
          control.channel !== binding.channel ||
          control.candidateRevision !== input.revision ||
          !binding.currentRevision ||
          control.candidateBaseRevision !== binding.currentRevision ||
          input.revision === binding.currentRevision ||
          control.checkFailed ||
          !control.lastCheckedAt ||
          control.lastCheckedAt.getTime() < Date.now() - SERVER_UPDATE_CHECK_INTERVAL_MS
        )
          throw new ServerUpdateConflict("Check for updates again");
        if (input.automatic) {
          if (
            !control.automatic ||
            control.consentedAccountKey !== binding.delegatedAccountKey ||
            !input.ownerUserId ||
            control.consentedUserId !== input.ownerUserId ||
            control.policyRevision !== input.policyRevision
          )
            return null;
          if (
            await tx.serverUpdateRequest.findFirst({
              where: { installationId: binding.installationId, revision: input.revision },
            })
          )
            return null;
        }
        if (
          await tx.serverUpdateRequest.findFirst({
            where: {
              installationId: binding.installationId,
              createdAt: { gt: new Date(Date.now() - SERVER_UPDATE_COOLDOWN_MS) },
            },
          })
        ) {
          if (input.automatic) return null;
          throw new ServerUpdateConflict("A deployment was requested recently");
        }
        return {
          created: true,
          request: await tx.serverUpdateRequest.create({
            data: {
              installationId: binding.installationId,
              idempotencyKey: input.idempotencyKey,
              revision: input.revision,
              automatic: input.automatic,
              policyRevision: control.policyRevision,
              delegatedAccountKey: binding.delegatedAccountKey,
            },
          }),
        };
      });
    },
    async begin(id: string) {
      return (
        (
          await prisma.serverUpdateRequest.updateMany({
            where: { id, installationId: binding.installationId, state: "queued" },
            data: { state: "submitting" },
          })
        ).count === 1
      );
    },
    async settle(id: string, state: "requested" | "unknown" | "failed") {
      await prisma.serverUpdateRequest.updateMany({
        where: {
          id,
          installationId: binding.installationId,
          state: { in: ["queued", "submitting"] },
        },
        data: { state },
      });
    },
  };
}
