// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; neutral integration changes follow LICENSE.md.

import { logSinkHealth } from "@orkbot/logging";
import { Hono } from "hono";

/**
 * `/health` is public liveness, so it stays a constant body. Deployment details are for
 * operators on the API port; a reverse proxy adds forwarding headers, so a request that
 * carries them came through the public edge and gets no details.
 */
export function healthRoutes(
  details: () => Record<string, unknown>,
  database?: () => Promise<unknown>,
  internalDetails?: () => Promise<Record<string, unknown>>,
) {
  const app = new Hono();
  // One probe at a time: polls during a hung check wait on it instead of taking more connections.
  let inFlight: Promise<boolean> | null = null;
  const probe = (check: () => Promise<unknown>) => {
    inFlight ??= Promise.resolve()
      .then(check)
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  let internalInFlight: Promise<Record<string, unknown> | null> | null = null;
  const readInternalDetails = (read: () => Promise<Record<string, unknown>>) => {
    internalInFlight ??= Promise.resolve()
      .then(read)
      .catch(() => null)
      .finally(() => {
        internalInFlight = null;
      });
    return internalInFlight;
  };
  app.get("/ready", async (c) => {
    const degraded = details().degraded === true;
    const databaseUp = database ? await withinDeadline(probe(database)) : true;
    const ok = !degraded && databaseUp;
    return c.json(
      { ok, degraded, ...(databaseUp ? {} : { database: "unreachable" }) },
      ok ? 200 : 503,
    );
  });
  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/internal/health", async (c) => {
    if (c.req.header("x-forwarded-for") || c.req.header("forwarded")) return c.notFound();
    const snapshot = { value: {} as Record<string, unknown> };
    const available =
      !internalDetails ||
      (await withinDeadline(
        readInternalDetails(internalDetails).then((value) => {
          if (value === null) return false;
          snapshot.value = value;
          return true;
        }),
      ));
    return c.json({
      ok: true,
      ...details(),
      ...(available ? snapshot.value : { diagnostics: "unavailable" }),
      telemetry: logSinkHealth(),
    });
  });
  return app;
}

export const DATABASE_CHECK_TIMEOUT_MS = 1500;

/** Readiness callers poll with short timeouts, so a hung database counts as unreachable. */
async function withinDeadline(check: Promise<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DATABASE_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
