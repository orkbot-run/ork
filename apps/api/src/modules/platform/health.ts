// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved; neutral integration changes follow LICENSE.md.

import { BlockList, isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import { logSinkHealth } from "@orkbot/logging";
import type { Context } from "hono";
import { Hono } from "hono";

const internalPeers = new BlockList();
for (const [address, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  internalPeers.addSubnet(address, prefix, "ipv4");
internalPeers.addAddress("::1", "ipv6");
internalPeers.addSubnet("fc00::", 7, "ipv6");

function hasInternalPeer(c: Context): boolean {
  // app.request()/fetch() in-process calls have no server bindings. Real Node requests do.
  if (!c.env || (!Object.hasOwn(c.env, "incoming") && !Object.hasOwn(c.env, "server"))) {
    return true;
  }
  try {
    const peer = getConnInfo(c).remote.address;
    if (typeof peer !== "string") return false;
    const family = isIP(peer);
    // BlockList matches IPv4-mapped IPv6 (both dotted and hexadecimal forms) to IPv4 ranges.
    return family !== 0 && internalPeers.check(peer, family === 6 ? "ipv6" : "ipv4");
  } catch {
    return false;
  }
}

/** Public liveness stays constant; deployment diagnostics require a private socket peer. */
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
    if (
      c.req.raw.headers.has("x-forwarded-for") ||
      c.req.raw.headers.has("forwarded") ||
      !hasInternalPeer(c)
    )
      return c.notFound();
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
