// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import type { MiddlewareHandler } from "hono";

/** Tracks handlers still running so shutdown can let them finish before closing the database. */
export function trackInFlightRequests() {
  const pending = new Set<Promise<void>>();
  const middleware: MiddlewareHandler = async (_c, next) => {
    const handled = next();
    pending.add(handled);
    try {
      await handled;
    } finally {
      pending.delete(handled);
    }
  };
  return { middleware, settled: () => Promise.allSettled([...pending]) };
}
