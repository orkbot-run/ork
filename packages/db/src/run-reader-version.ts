// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Prisma } from "./client.js";

/** Version 1 reads delegated attachment sources and authorized shared references. */
export const RUN_READER_VERSION = 1;

/** Version 2 also preserves explicit reply semantics through pauses and retries. */
export const EXPLICIT_REPLY_READER_VERSION = 2;
export const SUPPORTED_RUN_READER_VERSION = EXPLICIT_REPLY_READER_VERSION;

/** Claim-local only: never let a pooled connection advertise a reader after the transaction. */
export async function declareRunReaderVersion(tx: Pick<Prisma.TransactionClient, "$queryRaw">) {
  await tx.$queryRaw`SELECT set_config('app.run_reader_version', ${String(SUPPORTED_RUN_READER_VERSION)}, true)`;
}
