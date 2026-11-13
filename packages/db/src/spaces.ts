// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Space operations remain Apache-2.0; per-attempt account deletion leases and work admission guards are Ork additions.

import { randomUUID } from "node:crypto";
import { displayName } from "@orkbot/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import type { PageShareSecret } from "./page-shares.js";
import { deletePageShareSecrets } from "./page-shares.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { withTransactionRetry } from "./transaction-retry.js";

/** Per member, per organization: one person cannot fan out unbounded boundaries. */
const MAX_SPACES_PER_MEMBER = 32;

export class CentralWorkspaceCreationRequiredError extends Error {
  constructor() {
    super("Create workspaces in Accounts.");
    this.name = "CentralWorkspaceCreationRequiredError";
  }
}

export class SpaceLimitError extends Error {
  constructor() {
    super("Space limit reached");
    this.name = "SpaceLimitError";
  }
}

export class InvalidSpaceNameError extends Error {
  constructor() {
    super("Space name must be readable and between 1 and 60 characters");
    this.name = "InvalidSpaceNameError";
  }
}

export class SpaceNotFoundError extends Error {
  constructor() {
    super("Space not found");
    this.name = "SpaceNotFoundError";
  }
}

export class CannotDeleteDefaultSpaceError extends Error {
  constructor() {
    super("The default space cannot be deleted");
    this.name = "CannotDeleteDefaultSpaceError";
  }
}

export class CannotDeleteLastSpaceError extends Error {
  constructor() {
    super("The last remaining space cannot be deleted");
    this.name = "CannotDeleteLastSpaceError";
  }
}

export class CannotDeleteSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can delete it");
    this.name = "CannotDeleteSpaceAsNonOwnerError";
  }
}

export class CannotRenameSpaceAsNonOwnerError extends Error {
  constructor() {
    super("Only the space owner can rename it");
    this.name = "CannotRenameSpaceAsNonOwnerError";
  }
}

export class SpaceDeletionInProgressError extends Error {
  constructor() {
    super("Space deletion is already in progress");
    this.name = "SpaceDeletionInProgressError";
  }
}

export const SPACE_DELETION_CLAIM_TIMEOUT_MS = 5 * 60_000;

type SpaceClient = Pick<
  PrismaClient,
  "space" | "spaceMember" | "memoryDocument" | "notificationPreference" | "bot" | "chatGroup"
>;

interface CreateSpaceInput {
  spaceId: string;
  spaceMembershipId: string;
  organizationId: string;
  userId: string;
  name: string;
  createdAt: Date;
}

async function createSpace(prisma: SpaceClient, input: CreateSpaceInput): Promise<void> {
  await prisma.space.create({
    data: {
      id: input.spaceId,
      organizationId: input.organizationId,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.createdAt,
    },
  });
  await prisma.spaceMember.create({
    data: {
      id: input.spaceMembershipId,
      spaceId: input.spaceId,
      organizationId: input.organizationId,
      userId: input.userId,
      role: "owner",
      createdAt: input.createdAt,
    },
  });
}

async function createSpaceDefaults(
  prisma: SpaceClient,
  input: { spaceId: string; userId: string; memoryContent: string },
): Promise<void> {
  await prisma.memoryDocument.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
      scope: "user",
      path: "MEMORY.md",
      content: input.memoryContent,
    },
  });
  await prisma.notificationPreference.create({
    data: {
      spaceId: input.spaceId,
      userId: input.userId,
    },
  });
}

export function normalizeSpaceName(name: string): string {
  const trimmed = name.trim();
  if (!displayName(trimmed, "") || trimmed.length > 60) throw new InvalidSpaceNameError();
  return trimmed;
}

/** Create a sibling privacy boundary for a member of the active organization. */
export async function createSpaceForMember(
  prisma: PrismaClient,
  input: {
    currentSpaceId: string;
    userId: string;
    name: string;
  },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  const spaceId = randomUUID();
  const spaceMembershipId = randomUUID();
  const createdAt = new Date();

  await withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const currentMembership = await tx.spaceMember.findUnique({
          where: {
            spaceId_userId: {
              spaceId: input.currentSpaceId,
              userId: input.userId,
            },
          },
          select: { organizationId: true },
        });
        if (!currentMembership) throw new IsolationError();
        await lockOrganizationSpaces(tx, currentMembership.organizationId);
        const central = await runAsSystemInTransaction(
          tx,
          "check whether Accounts manages workspace creation",
          () =>
            tx.centralWorkspaceBinding.findFirst({
              where: { localOrganizationId: currentMembership.organizationId },
              select: { id: true },
            }),
        );
        if (central) throw new CentralWorkspaceCreationRequiredError();
        const deleting = await tx.space.count({
          where: {
            organizationId: currentMembership.organizationId,
            isDefault: true,
            deletingAt: { not: null },
          },
        });
        if (deleting > 0) throw new SpaceDeletionInProgressError();
        const count = await tx.spaceMember.count({
          where: {
            userId: input.userId,
            organizationId: currentMembership.organizationId,
          },
        });
        if (count >= MAX_SPACES_PER_MEMBER) throw new SpaceLimitError();
        await createSpace(tx, {
          spaceId,
          spaceMembershipId,
          organizationId: currentMembership.organizationId,
          userId: input.userId,
          name,
          createdAt,
        });
        await createSpaceDefaults(tx, {
          spaceId,
          userId: input.userId,
          memoryContent: "# Space memory\n\n",
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  return { id: spaceId, name };
}

type SpaceMemberTargetInput = {
  currentSpaceId: string;
  userId: string;
  spaceId: string;
};

/** Serialize content creation with the empty-space deletion claim. */
export async function lockSpaceForContentCreation(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; userId: string },
): Promise<{ organizationId: string }> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))::text AS "lock"
  `);
  const membership = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: {
      organizationId: true,
      space: { select: { deletingAt: true } },
    },
  });
  if (!membership) throw new IsolationError();
  if (membership.space.deletingAt) throw new SpaceDeletionInProgressError();
  await assertSpaceAcceptsWork(tx, input.spaceId);
  return { organizationId: membership.organizationId };
}

/** Serialize work admission with deletion before taking any thread, bot, routine, or computer lock. */
export async function lockSpaceForWork(
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock_shared(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
  await assertSpaceAcceptsWork(tx, spaceId);
}

async function assertSpaceAcceptsWork(
  tx: Prisma.TransactionClient,
  spaceId: string,
): Promise<void> {
  // Existing target foreign keys and caller authorization establish the Space. A missing row
  // cannot accept new work; its target write fails normally without exposing another Space.
  // A row lock rejects an obsolete Serializable/Repeatable Read snapshot after waiting for
  // deletion, so a retried transaction observes the claim instead of admitting stale work.
  const spaces = await tx.$queryRaw<Array<{ deletingAt: Date | null }>>(Prisma.sql`
    SELECT "deletingAt" FROM spaces WHERE id = ${spaceId} FOR SHARE
  `);
  if (spaces.some((space) => space.deletingAt)) throw new SpaceDeletionInProgressError();
}

/** Serializes creating a Space in an organization with claiming the organization for deletion. */
export async function lockOrganizationSpaces(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`organization-spaces:${organizationId}`}, 0))::text AS "lock"
  `);
}

async function lockSpaceDeletion(tx: Prisma.TransactionClient, spaceId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))::text AS "lock"
  `);
}

type ClaimedSpaceDeleteInput = SpaceMemberTargetInput & { claimId: string };

async function loadActorSpace(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
) {
  const currentMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.currentSpaceId,
        userId: input.userId,
      },
    },
    select: { organizationId: true },
  });
  if (!currentMembership) throw new IsolationError();
  const targetMembership = await db.spaceMember.findUnique({
    where: {
      spaceId_userId: {
        spaceId: input.spaceId,
        userId: input.userId,
      },
    },
    select: {
      organizationId: true,
      role: true,
      space: { select: { isDefault: true, deletingAt: true } },
    },
  });
  if (!targetMembership || targetMembership.organizationId !== currentMembership.organizationId) {
    throw new SpaceNotFoundError();
  }
  return {
    organizationId: currentMembership.organizationId,
    role: targetMembership.role,
    isDefault: targetMembership.space.isDefault,
    deletingAt: targetMembership.space.deletingAt,
  };
}

/** Owner of a non-default Space that is not their last one in the organization. */
async function assertSpaceDeletable(
  db: Pick<PrismaClient, "spaceMember">,
  input: SpaceMemberTargetInput,
): Promise<Array<{ spaceId: string; space: { isDefault: boolean } }>> {
  const owned = await loadActorSpace(db, input);
  if (owned.role !== "owner") throw new CannotDeleteSpaceAsNonOwnerError();
  if (owned.isDefault) throw new CannotDeleteDefaultSpaceError();
  const memberships = await db.spaceMember.findMany({
    where: {
      userId: input.userId,
      organizationId: owned.organizationId,
    },
    select: { spaceId: true, space: { select: { isDefault: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length <= 1) throw new CannotDeleteLastSpaceError();
  return memberships;
}

/**
 * Claim a Space before tearing down its content. Bot and group creation take the same
 * advisory lock and reject a claimed Space, so once claimed it only loses content. A stale
 * claim may be taken over after five minutes; that is safe because destroys are idempotent,
 * every worker verifies its claim token before and after each destroy, provider-handle
 * clearing is conditioned on the claim token, and no worker releases its claim once
 * destructive teardown starts.
 */
export async function claimSpaceDeletionForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput,
): Promise<{ claimId: string; recovered: boolean }> {
  const claimId = randomUUID();
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        await assertSpaceDeletable(tx, input);
        const lifecycle = await tx.space.findUnique({
          where: { id: input.spaceId },
          select: { deletingAt: true },
        });
        const claimedBefore = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        const claimed = await tx.space.updateMany({
          where: {
            id: input.spaceId,
            OR: [{ deletingAt: null }, { deletingAt: { lt: claimedBefore } }],
          },
          data: { deletingAt: new Date(), deletionClaimId: claimId },
        });
        if (claimed.count === 0) throw new SpaceDeletionInProgressError();
        return { claimId, recovered: Boolean(lifecycle?.deletingAt) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Every bot of a claimed Space, archived and other members' included, for per-bot teardown. */
export async function listClaimedSpaceBots(
  prisma: Pick<PrismaClient, "bot">,
  input: ClaimedSpaceDeleteInput,
) {
  return prisma.bot.findMany({
    where: { spaceId: input.spaceId, space: { deletionClaimId: input.claimId } },
    select: {
      id: true,
      userId: true,
      spaceId: true,
      name: true,
      archivedAt: true,
      computerId: true,
      webhookSecretId: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/** Sandboxes still provisioned in a claimed Space once its bots are gone (team computers). */
export async function listClaimedSpaceComputers(
  prisma: Pick<PrismaClient, "computer">,
  input: ClaimedSpaceDeleteInput,
): Promise<Array<{ id: string; homeKey: string; kind: string; providerRef: string }>> {
  const computers = await prisma.computer.findMany({
    where: {
      spaceId: input.spaceId,
      providerRef: { not: null },
      space: { deletionClaimId: input.claimId },
    },
    select: { id: true, homeKey: true, kind: true, providerRef: true },
  });
  return computers.flatMap((computer) =>
    computer.providerRef ? [{ ...computer, providerRef: computer.providerRef }] : [],
  );
}

export async function renewSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<boolean> {
  const renewed = await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: new Date() },
  });
  return renewed.count === 1;
}

/** Release only this caller's deletion claim when nothing has been torn down yet. */
export async function releaseSpaceDeletionClaim(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<void> {
  await prisma.space.updateMany({
    where: {
      id: input.spaceId,
      deletionClaimId: input.claimId,
      memberships: { some: { userId: input.userId, role: "owner" } },
    },
    data: { deletingAt: null, deletionClaimId: null },
  });
}

/**
 * Delete a claimed, non-default Space and everything left in it. Callers must first
 * destroy every bot and leftover sandbox, clearing its providerRef, so a failed external
 * destroy never loses the only persisted handle; remaining rows go by cascade. Returns the
 * stored artifacts and computer homes to remove after commit, and the space the client
 * should switch to when the active space was deleted.
 */
export async function deleteClaimedSpaceForMember(
  prisma: PrismaClient,
  input: ClaimedSpaceDeleteInput,
): Promise<{
  id: string;
  artifactKeys: string[];
  homeKeys: string[];
  pageShareSecrets: PageShareSecret[];
}> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const claim = await tx.space.findFirst({
          where: { id: input.spaceId, deletionClaimId: input.claimId },
          select: { id: true },
        });
        if (!claim) throw new SpaceDeletionInProgressError();
        const memberships = await assertSpaceDeletable(tx, input);
        const [remainingBots, provisioned, artifacts, computers] = await Promise.all([
          tx.bot.count({ where: { spaceId: input.spaceId } }),
          tx.computer.count({ where: { spaceId: input.spaceId, providerRef: { not: null } } }),
          tx.artifact.findMany({
            where: { spaceId: input.spaceId },
            select: { storageKey: true },
          }),
          tx.computer.findMany({ where: { spaceId: input.spaceId }, select: { homeKey: true } }),
        ]);
        // Content creation is blocked while claimed, so this only trips when teardown
        // was cut short; a retry finishes it.
        if (remainingBots > 0 || provisioned > 0) throw new SpaceDeletionInProgressError();
        const pageShareSecrets = await deletePageShareSecrets(tx, { spaceId: input.spaceId });
        await tx.space.delete({ where: { id: input.spaceId } });
        const removed = {
          artifactKeys: artifacts.map((artifact) => artifact.storageKey),
          homeKeys: computers.map((computer) => computer.homeKey),
          pageShareSecrets,
        };
        if (input.spaceId !== input.currentSpaceId) {
          return { id: input.currentSpaceId, ...removed };
        }
        const remaining = memberships.filter((membership) => membership.spaceId !== input.spaceId);
        const fallback = remaining.find((membership) => membership.space.isDefault) ?? remaining[0];
        if (!fallback) throw new CannotDeleteLastSpaceError();
        return { id: fallback.spaceId, ...removed };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

/** Organizations whose only member is this user; they are deleted with the account. */
export async function personalOrganizationIds(
  prisma: Pick<PrismaClient, "member">,
  userId: string,
): Promise<string[]> {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: {
      organizationId: true,
      organization: { select: { members: { select: { userId: true } } } },
    },
  });
  return memberships
    .filter(({ organization }) => organization.members.every((member) => member.userId === userId))
    .map(({ organizationId }) => organizationId);
}

/**
 * Claims the account and its leaving Spaces atomically under one attempt identity. The account
 * lease also covers shared-only accounts and cleanup after the last claimed Space disappears.
 * A live earlier attempt is never reused; a lapsed attempt is taken over under the new token.
 */
export async function claimSpacesLeavingWithAccount(
  prisma: PrismaClient,
  userId: string,
): Promise<{ claimId: string; spaceIds: string[] }> {
  const claimId = `account-deletion:${userId}:${randomUUID()}`;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockAccountDeletion(tx, userId);
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { accountDeletionClaimId: true, accountDeletionClaimedAt: true },
        });
        if (!user) throw new IsolationError();
        const stale = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
        if (
          user.accountDeletionClaimId &&
          user.accountDeletionClaimedAt &&
          user.accountDeletionClaimedAt >= stale
        )
          throw new SpaceDeletionInProgressError();
        // Exact stored identities avoid treating another account's token as a prefix match.
        // The previous release used one token for all of this account's attempts.
        const earlierClaimIds = [
          `account-deletion:${userId}`,
          ...(user.accountDeletionClaimId ? [user.accountDeletionClaimId] : []),
        ];
        const earlier: Prisma.SpaceWhereInput = {
          deletionClaimId: { in: earlierClaimIds },
        };
        if (await tx.space.count({ where: { ...earlier, deletingAt: { gte: stale } } }))
          throw new SpaceDeletionInProgressError();
        await tx.user.update({
          where: { id: userId },
          data: { accountDeletionClaimId: claimId, accountDeletionClaimedAt: new Date() },
        });
        const organizationIds = await personalOrganizationIds(tx, userId);
        const candidates = await tx.space.findMany({
          where: {
            OR: [
              { organizationId: { in: organizationIds } },
              { memberships: { some: { userId }, every: { userId } } },
              earlier,
            ],
          },
          select: { id: true, deletionClaimId: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        const spaceIds: string[] = [];
        for (const candidate of candidates) {
          // A Space someone joined during a failed earlier attempt still needs its claim
          // released by deleteClaimedSpace after this account's remaining content is gone.
          const resuming =
            candidate.deletionClaimId !== null &&
            earlierClaimIds.includes(candidate.deletionClaimId);
          if (resuming) {
            await lockSpaceDeletion(tx, candidate.id);
            const taken = await tx.space.updateMany({
              where: {
                id: candidate.id,
                deletionClaimId: candidate.deletionClaimId,
                OR: [{ deletingAt: null }, { deletingAt: { lt: stale } }],
              },
              data: { deletingAt: new Date(), deletionClaimId: claimId },
            });
            if (taken.count === 0) throw new SpaceDeletionInProgressError();
          }
          if (await claimSpaceForDeletion(tx, candidate.id, claimId, userId))
            spaceIds.push(candidate.id);
        }
        return { claimId, spaceIds };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function lockAccountDeletion(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`account-deletion:${userId}`}, 0))::text AS "lock"
  `);
}

/** Renews only the account attempt still held by this caller, along with its remaining Spaces. */
export async function setAccountDeletionLease(
  prisma: PrismaClient,
  input: { userId: string; claimId: string; at: Date },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockAccountDeletion(tx, input.userId);
    const { count } = await tx.user.updateMany({
      where: { id: input.userId, accountDeletionClaimId: input.claimId },
      data: { accountDeletionClaimedAt: input.at },
    });
    if (count === 0) return false;
    await tx.space.updateMany({
      where: { deletionClaimId: input.claimId },
      data: { deletingAt: input.at },
    });
    return true;
  });
}

/** Releases only this settled attempt, so a failed deletion can be retried immediately. */
export async function releaseAccountDeletionClaim(
  prisma: PrismaClient,
  input: { userId: string; claimId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockAccountDeletion(tx, input.userId);
    await tx.space.updateMany({
      where: { deletionClaimId: input.claimId },
      data: { deletingAt: null, deletionClaimId: null },
    });
    await tx.user.updateMany({
      where: { id: input.userId, accountDeletionClaimId: input.claimId },
      data: { accountDeletionClaimId: null, accountDeletionClaimedAt: null },
    });
  });
}

/**
 * Claims a Space for a whole-account or whole-organization deletion, keeping a claim it already
 * holds. False when the Space is gone or, with `soleMemberId`, someone else belongs to it.
 */
export async function claimSpaceForDeletion(
  tx: Prisma.TransactionClient,
  spaceId: string,
  claimId: string,
  soleMemberId?: string,
): Promise<boolean> {
  await lockSpaceDeletion(tx, spaceId);
  const space = await tx.space.findUnique({
    where: { id: spaceId },
    select: { deletingAt: true, deletionClaimId: true },
  });
  if (!space) return false;
  if (space.deletionClaimId === claimId) return true;
  if (soleMemberId) {
    const others = await tx.spaceMember.count({
      where: { spaceId, userId: { not: soleMemberId } },
    });
    if (others > 0) return false;
  }
  const stale = new Date(Date.now() - SPACE_DELETION_CLAIM_TIMEOUT_MS);
  if (space.deletionClaimId && space.deletingAt && space.deletingAt >= stale)
    throw new SpaceDeletionInProgressError();
  await tx.space.update({
    where: { id: spaceId },
    data: { deletingAt: new Date(), deletionClaimId: claimId },
  });
  return true;
}

/**
 * Delete a space claimed by `claimSpaceForDeletion`, once its bots and sandboxes are gone. Rows
 * left in it go by cascade, and its keys with it. Returns the stored artifacts to remove after
 * commit, but none when another claim has since taken the space over. With `soleMemberId`, a
 * space someone joined after the claim is released instead and null is returned. With
 * `organizationId`, the organization goes in the same transaction once its last Space does, so it
 * is never left without the claim that lets a retry find it.
 */
export async function deleteClaimedSpace(
  prisma: PrismaClient,
  input: { spaceId: string; claimId: string; soleMemberId?: string; organizationId?: string },
): Promise<{ artifactKeys: string[]; pageShareSecrets: PageShareSecret[] } | null> {
  const { spaceId, claimId, soleMemberId, organizationId } = input;
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, spaceId);
        const [others, remainingBots, remainingComputers, artifacts] = await Promise.all([
          soleMemberId
            ? tx.spaceMember.count({ where: { spaceId, userId: { not: soleMemberId } } })
            : 0,
          tx.bot.count({ where: { spaceId } }),
          tx.computer.count({ where: { spaceId } }),
          tx.artifact.findMany({ where: { spaceId }, select: { storageKey: true } }),
        ]);
        if (others > 0) {
          await tx.space.updateMany({
            where: { id: spaceId, deletionClaimId: claimId },
            data: { deletingAt: null, deletionClaimId: null },
          });
          return null;
        }
        // Teardown was cut short; deleting again finishes it.
        if (remainingBots > 0 || remainingComputers > 0) throw new SpaceDeletionInProgressError();
        // The page links' tokens go with the Space; the caller removes them from the store.
        const pageShareSecrets = await tx.secret.findMany({
          where: { pageShare: { is: { spaceId } } },
          select: { id: true, ciphertext: true },
        });
        const gone = await tx.space.deleteMany({
          where: { id: spaceId, deletionClaimId: claimId },
        });
        if (organizationId)
          await tx.organization.deleteMany({ where: { id: organizationId, spaces: { none: {} } } });
        // The Space went to another claim: its rows and stored files are not this caller's.
        return {
          artifactKeys: gone.count > 0 ? artifacts.map((artifact) => artifact.storageKey) : [],
          pageShareSecrets: gone.count > 0 ? pageShareSecrets : [],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export async function renameSpaceForMember(
  prisma: PrismaClient,
  input: SpaceMemberTargetInput & { name: string },
): Promise<{ id: string; name: string }> {
  const name = normalizeSpaceName(input.name);
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockSpaceDeletion(tx, input.spaceId);
        const owned = await loadActorSpace(tx, input);
        if (owned.role !== "owner") throw new CannotRenameSpaceAsNonOwnerError();
        if (owned.deletingAt) throw new SpaceDeletionInProgressError();
        await tx.space.update({
          where: { id: input.spaceId },
          data: { name },
        });
        return { id: input.spaceId, name };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
