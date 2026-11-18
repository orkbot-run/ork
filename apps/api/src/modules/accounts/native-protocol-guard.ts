// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import type { MiddlewareHandler } from "hono";

/** Preserve the public, read-only status endpoint while rejecting legacy native login. */
export function nativeProtocolGuard(registered: () => Promise<boolean>): MiddlewareHandler {
  return async (c, next) => {
    if (
      !c.req.path.startsWith("/api/auth/native/workspace/") &&
      !(c.req.method === "GET" && c.req.path === "/api/auth/native/workspace-status") &&
      (await registered())
    ) {
      return c.json({ error: "update_required", identityProtocol: 2 }, 426);
    }
    return next();
  };
}
