// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";

export const NATIVE_SESSION_IDENTITY_PREFIX = "native-session-identity-v1:";
export const nativeSessionIdentityKey = (sessionId: string) =>
  NATIVE_SESSION_IDENTITY_PREFIX + sessionId;

/** A linked identity alone never proves which account authenticated a particular session. */
export async function verifiedNativeSessionIdentity(
  prisma: PrismaClient,
  sessionId: string,
  userId: string,
  issuer: string,
): Promise<string | null> {
  const [session, proof] = await Promise.all([
    prisma.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
    prisma.verification.findFirst({
      where: { identifier: nativeSessionIdentityKey(sessionId), expiresAt: { gt: new Date() } },
      select: { value: true },
    }),
  ]);
  if (!session || !proof) return null;
  let identity: unknown;
  try {
    identity = JSON.parse(proof.value);
  } catch {
    return null;
  }
  if (
    !Array.isArray(identity) ||
    identity.length !== 3 ||
    identity[0] !== issuer ||
    identity[1] !== userId ||
    typeof identity[2] !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity[2])
  )
    return null;
  const linked = await prisma.account.findFirst({
    where: { userId, providerId: "oidc", accountId: identity[2] },
    select: { id: true },
  });
  return linked ? identity[2] : null;
}
