// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";

/** Local operator delegation never infers ownership from an email or an organization role. */
export async function setAIAdministrator(
  prisma: PrismaClient,
  input: {
    accountKey: string;
    fingerprint: string;
    enabled: boolean;
  },
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.accountKey) || !/^[a-f0-9]{64}$/.test(input.fingerprint))
    throw new Error("Supply the exact account key and installation fingerprint");
  await runAsSystem("explicitly delegate installation AI administration", () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
      const installation = await tx.installationIdentity.findUnique({ where: { id: "local" } });
      if (
        installation?.state !== "ready" ||
        !installation.localOrganizationId ||
        installation.keyFingerprint !== input.fingerprint
      )
        throw new Error("Installation binding changed");
      if (input.enabled)
        await tx.aIConnectionAdministrator.upsert({
          where: { accountKey: input.accountKey },
          create: { accountKey: input.accountKey, bindingVersion: installation.bindingVersion },
          update: { bindingVersion: installation.bindingVersion },
        });
      else
        await tx.aIConnectionAdministrator.deleteMany({ where: { accountKey: input.accountKey } });
      await tx.auditEvent.create({
        data: {
          organizationId: installation.localOrganizationId,
          actorType: "system",
          actorLabel: "Local operator",
          action: input.enabled ? "ai.administrator.granted" : "ai.administrator.revoked",
          targetType: "account",
          targetId: input.accountKey,
          outcome: "success",
          metadata: { bindingVersion: installation.bindingVersion },
        },
      });
    }),
  );
}
