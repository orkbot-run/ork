// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited budget material remains Apache-2.0; Ork module extraction is PolyForm-covered.

// Transactions that lock the thread row before writing run state share the body budget: the
// lock is held up to 15s by snapshot reads, Prisma's 5s default counts that wait, and expiring
// fails a user stop, clear, send, reaction or card answer, a run's steering claim or takeover
// handoff, or a run whose work already finished. Only the timeout is shared; an explicit
// maxWait would override the client's longer connection wait, so a saturated pool that frees
// a connection late would fail the checkout instead of waiting.
export const THREAD_LOCK_TRANSACTION_OPTIONS = { timeout: 20_000 };
