// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import type { MiddlewareHandler } from "hono";

/** Reject legacy login on centrally registered servers without breaking the public status page. */
export function nativeProtocolGuard(registered: () => Promise<boolean>): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith("/api/auth/native/workspace/") || !(await registered()))
      return next();
    if (c.req.method === "GET" && c.req.path === "/api/auth/native/workspace-status") {
      // The legacy status endpoint only knows the old claim format. A registered installation
      // may have multiple workspaces, so let the page direct people to the dashboard instead.
      return c.json({ status: "unknown" });
    }
    return c.json({ error: "update_required", identityProtocol: 2 }, 426);
  };
}
