// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Prisma, PrismaClient } from "@orkbot/db";

export const OAUTH_REFRESH_LOCK_WAIT_MS = 10_000;
export const OAUTH_REFRESH_REQUEST_TIMEOUT_MS = 15_000;
const OAUTH_REFRESH_TRANSACTION_MS = 60_000;

/** Keep a credential's reread, provider refresh and write on one database connection. */
export function withOAuthRefreshLock<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  namespace: string,
  key: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${OAUTH_REFRESH_LOCK_WAIT_MS}ms`}, true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${namespace}), hashtext(${key}))`;
      return work(tx);
    },
    { maxWait: OAUTH_REFRESH_LOCK_WAIT_MS, timeout: OAUTH_REFRESH_TRANSACTION_MS },
  );
}

/** A caller cancellation may shorten, but never extend, a provider request. */
export function oauthRefreshSignal(signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(OAUTH_REFRESH_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
