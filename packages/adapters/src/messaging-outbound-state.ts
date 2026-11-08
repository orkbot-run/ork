// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash } from "node:crypto";
import type { Actor, MessagingOutboundList, MessagingOutboundResolution } from "@orkbot/contracts";
import { sanitizeMessagingLabel } from "@orkbot/core";
import type { MessagingIdentity, MessagingOutbound, PrismaClient } from "@orkbot/db";
import { lockSpaceForWork, Prisma } from "@orkbot/db";

export const DIRECT_DELIVERY_VERSION = 1;
export const MESSAGING_ROW_IN_FLIGHT_MS = 2 * 60_000;

export class MessagingOutboundReviewError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT") {
    super(code);
    this.name = "MessagingOutboundReviewError";
  }
}

export async function declareDirectDelivery(tx: Pick<Prisma.TransactionClient, "$queryRaw">) {
  await tx.$queryRaw`SELECT set_config('app.messaging_delivery_version', ${String(DIRECT_DELIVERY_VERSION)}, true)`;
}

/** A failed send is retryable only when its producer proved rejection or never began sending. */
export async function declareRejectedDelivery(tx: Pick<Prisma.TransactionClient, "$queryRaw">) {
  await tx.$queryRaw`SELECT set_config('app.messaging_delivery_outcome', 'rejected', true)`;
}

/** The caller holds the identity lock; timeout proves uncertainty, never a remote rejection. */
export async function quarantineStaleDirectClaims(
  tx: Prisma.TransactionClient,
  identityId: string,
) {
  return tx.messagingOutbound.updateMany({
    where: {
      identityId,
      kind: "dm",
      status: "sent",
      providerHandle: null,
      updatedAt: { lt: new Date(Date.now() - MESSAGING_ROW_IN_FLIGHT_MS) },
    },
    data: {
      status: "uncertain",
      requiredDeliveryVersion: DIRECT_DELIVERY_VERSION,
      nextAttemptAt: null,
    },
  });
}

type DeliveryIdentity = Pick<MessagingIdentity, "id" | "spaceId" | "userId" | "botId">;
type DeliverySource = Pick<MessagingOutbound, "id" | "sourceMessageId">;

function sourceProof(identity: DeliveryIdentity, sourceId: Prisma.Sql) {
  return Prisma.sql`COALESCE(direct_delivery_source_allowed(${identity.id}, ${sourceId}), false)`;
}

function systemSourceProof(identity: DeliveryIdentity, outboundId: Prisma.Sql) {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM messaging_outbound receipt JOIN bots bot ON bot.id = ${identity.botId}
    WHERE receipt.id = ${outboundId} AND receipt."identityId" = ${identity.id}
      AND receipt."sourceMessageId" IS NULL AND is_system_delivery_key(receipt."idempotencyKey", ${identity.id})
      AND receipt."sourceBinding" = direct_delivery_identity_binding(${identity.id}, ${identity.userId}, ${identity.spaceId}, ${identity.botId})
      AND bot."spaceId" = ${identity.spaceId} AND bot."userId" = ${identity.userId} AND bot."archivedAt" IS NULL
      AND EXISTS (SELECT 1 FROM space_members membership
        WHERE membership."spaceId" = ${identity.spaceId} AND membership."userId" = ${identity.userId})
  )`;
}

/** Server receipts require a pinned binding; mirrored replies require live source history. */
export async function directDeliverySourceAvailable(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  identity: DeliveryIdentity,
  row: DeliverySource,
): Promise<boolean> {
  const [result] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT (${sourceProof(identity, Prisma.sql`${row.sourceMessageId}`)} OR ${systemSourceProof(identity, Prisma.sql`${row.id}`)}) AS allowed`;
  return result?.allowed === true;
}

/** Retiring unavailable history is not a delivery decision and never retries the old content. */
export async function retireDirectDelivery(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT set_config('app.messaging_delivery_resolution', 'source_unavailable', true)`;
  return tx.messagingOutbound.updateMany({
    where: { id, kind: "dm", status: { in: ["pending", "sent", "uncertain"] } },
    data: {
      status: "retired",
      requiredDeliveryVersion: DIRECT_DELIVERY_VERSION,
      nextAttemptAt: null,
    },
  });
}

export async function retireUnavailableUnknowns(
  tx: Prisma.TransactionClient,
  identity: DeliveryIdentity,
) {
  await tx.$queryRaw`SELECT set_config('app.messaging_delivery_resolution', 'source_unavailable', true)`;
  // One set-based update returns only its count, including when many obsolete replies remain.
  return tx.$executeRaw`UPDATE messaging_outbound outbound SET status = 'retired',
      "requiredDeliveryVersion" = GREATEST("requiredDeliveryVersion", ${DIRECT_DELIVERY_VERSION}),
      "nextAttemptAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE outbound."identityId" = ${identity.id} AND outbound.kind = 'dm' AND outbound.status = 'uncertain'
      AND NOT (${sourceProof(identity, Prisma.sql`outbound."sourceMessageId"`)}
        OR ${systemSourceProof(identity, Prisma.sql`outbound.id`)})`;
}

export function unresolvedDirectWhere(identityId: string): Prisma.MessagingOutboundWhereInput {
  return {
    identityId,
    kind: "dm",
    OR: [
      { status: "uncertain" },
      {
        status: "sent",
        providerHandle: null,
        updatedAt: { lt: new Date(Date.now() - MESSAGING_ROW_IN_FLIGHT_MS) },
      },
    ],
  };
}

async function ownedIdentity(
  tx: Prisma.TransactionClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  id: string,
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM messaging_identities
    WHERE id = ${id} AND "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId} FOR UPDATE`;
  if (locked.length !== 1) throw new MessagingOutboundReviewError("NOT_FOUND");
  const identity = await tx.messagingIdentity.findFirst({
    where: { id, spaceId: actor.spaceId, userId: actor.userId },
  });
  const bot =
    identity &&
    (await tx.bot.findFirst({
      where: {
        id: identity.botId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        space: { memberships: { some: { userId: actor.userId } } },
      },
      select: { id: true },
    }));
  if (!identity || !bot) throw new MessagingOutboundReviewError("NOT_FOUND");
  return identity;
}

function reviewVersion(identity: MessagingIdentity, row: MessagingOutbound): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.id,
        identity.userId,
        identity.spaceId,
        identity.botId,
        identity.updatedAt.toISOString(),
        row.id,
        row.status,
        row.updatedAt.toISOString(),
      ]),
    )
    .digest("hex");
}

export async function listUnknownDirectDeliveries(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  identityId: string,
): Promise<MessagingOutboundList & { retiredCount: number }> {
  return prisma.$transaction(async (tx) => {
    const identity = await ownedIdentity(tx, actor, identityId);
    await quarantineStaleDirectClaims(tx, identity.id);
    const retiredCount = await retireUnavailableUnknowns(tx, identity);
    const rows = await tx.messagingOutbound.findMany({
      where: { identityId: identity.id, kind: "dm", status: "uncertain" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 21,
    });
    const items = [];
    for (const row of rows.slice(0, 20)) {
      const artifactId = /^msg:[^:]+:file:([^:]+)$/.exec(row.idempotencyKey)?.[1];
      const artifact =
        artifactId &&
        (await tx.artifact.findFirst({
          where: { id: artifactId, userId: actor.userId, spaceId: actor.spaceId },
          select: { name: true },
        }));
      items.push({
        id: row.id,
        version: reviewVersion(identity, row),
        preview: row.body.slice(0, 1000),
        createdAt: row.createdAt.toISOString(),
        attachmentName: artifact ? sanitizeMessagingLabel(artifact.name) : null,
      });
    }
    return { items, hasMore: rows.length > 20, retiredCount };
  });
}

/** Both decisions release later work; neither resends the ambiguous message. */
export async function resolveUnknownDirectDelivery(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: {
    identityId: string;
    outboundId: string;
    version: string;
    resolution: MessagingOutboundResolution;
  },
): Promise<{ changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    await lockSpaceForWork(tx, actor.spaceId);
    const identity = await ownedIdentity(tx, actor, input.identityId);
    const row = await tx.messagingOutbound.findFirst({
      where: { id: input.outboundId, identityId: identity.id, kind: "dm" },
    });
    if (!row) throw new MessagingOutboundReviewError("NOT_FOUND");
    const status = input.resolution === "confirmed_sent" ? "resolved_sent" : "resolved_not_sent";
    if (row.status === status) return { changed: false };
    if (row.status === "uncertain" && !(await directDeliverySourceAvailable(tx, identity, row))) {
      await retireDirectDelivery(tx, row.id);
      return { changed: false };
    }
    if (row.status !== "uncertain" || reviewVersion(identity, row) !== input.version)
      throw new MessagingOutboundReviewError("CONFLICT");
    await tx.$queryRaw`SELECT set_config('app.messaging_delivery_resolution', ${input.resolution}, true)`;
    const resolved = await tx.messagingOutbound.updateMany({
      where: { id: row.id, identityId: identity.id, status: "uncertain", updatedAt: row.updatedAt },
      data: { status, nextAttemptAt: null },
    });
    if (resolved.count !== 1) throw new MessagingOutboundReviewError("CONFLICT");
    return { changed: true };
  });
}
