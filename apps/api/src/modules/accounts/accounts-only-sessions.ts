// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { OIDC_SESSION_PREFIX } from "@orkbot/auth";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";

/** Expire unproven sign-ins before devices and notifications begin accepting work. */
export async function expireNonOidcSessions(
  prisma: PrismaClient,
  issuer: string,
  expectedOwnerKey?: string,
) {
  return runAsSystem("expire sign-ins outside the configured identity provider", () =>
    prisma.$transaction(async (tx) => {
      const expiredSessions = await tx.$executeRaw`
        UPDATE "session" AS session
        SET "expiresAt" = date_trunc('milliseconds', NOW()), "updatedAt" = NOW()
        WHERE session."expiresAt" > NOW()
          AND (
            NOT EXISTS (
              SELECT 1 FROM "verification" AS proof
              WHERE proof."identifier" = ${OIDC_SESSION_PREFIX} || session."id"
                AND proof."value" = '[' || to_json(${issuer}::text)::text || ',' ||
                  to_json(session."userId")::text || ']'
                AND proof."expiresAt" > NOW()
            )
            OR (${expectedOwnerKey ?? null}::text IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM "account" AS identity
              WHERE identity."userId" = session."userId"
                AND identity."providerId" = 'oidc'
                AND identity."accountId" = ${expectedOwnerKey ?? null}
            ))
          )
      `;
      const revokedDevices = await tx.$executeRaw`
        UPDATE "user_devices" AS device
        SET "revokedAt" = NOW(), "revokedBy" = 'session'
        WHERE device."revokedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "session" AS session
            WHERE session."id" = device."sessionId"
              AND session."userId" = device."userId"
              AND session."expiresAt" > NOW()
          )
      `;
      return { expiredSessions, revokedDevices };
    }),
  );
}
