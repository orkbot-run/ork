// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { bootstrapUserSpace } from "@orkbot/db";

/** Initialize only the identity that originally claimed this server. Never link by email. */
export async function initializeWorkspaceOwner(
  prisma: PrismaClient,
  input: {
    accountKey: string;
    organizationId: string;
    claimId: string;
    email: string;
    name: string;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('orkbot:dashboard-workspace-owner'))`;
    const settings = await tx.deploymentSettings.findUnique({
      where: { id: "default" },
      select: {
        nativeAccountsOwnerKey: true,
        nativeAccountsOrganizationId: true,
        nativeAccountsWorkspaceClaimId: true,
      },
    });
    if (
      settings?.nativeAccountsOwnerKey !== input.accountKey ||
      settings.nativeAccountsOrganizationId !== input.organizationId ||
      settings.nativeAccountsWorkspaceClaimId !== input.claimId
    )
      throw new Error("Workspace connection changed");
    let account = await tx.account.findFirst({
      where: { providerId: "oidc", accountId: input.accountKey },
      select: { userId: true },
    });
    if (!account) {
      // Match the native login flow: an unrelated local account must never be linked by email.
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } }))
        throw new Error("Workspace owner identity conflicts with an existing account");
      const user = await tx.user.create({
        data: { id: randomUUID(), email: input.email, emailVerified: true, name: input.name },
        select: { id: true },
      });
      account = await tx.account.create({
        data: {
          id: randomUUID(),
          providerId: "oidc",
          accountId: input.accountKey,
          userId: user.id,
        },
        select: { userId: true },
      });
    }
    const space = await tx.space.findFirst({
      where: { createdByUserId: account.userId, isDefault: true, deletingAt: null },
      select: { id: true },
    });
    if (!space)
      await bootstrapUserSpace(
        tx as PrismaClient,
        { id: account.userId },
        {
          signupsEnabled: undefined,
          signupAllowlist: undefined,
        },
      );
  });
}
