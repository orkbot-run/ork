// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Hono } from "hono";

/** Preserve the registered native loopback callback while using the shared OIDC handler. */
export function mountAuthCallback(app: Hono, redirectURI: string | undefined, authUrl: string) {
  app.get("/callback", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (!redirectURI) return c.notFound();
    const configured = new URL(redirectURI);
    const origin = new URL(authUrl);
    if (
      configured.origin !== origin.origin ||
      configured.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(configured.hostname) ||
      configured.pathname !== "/callback" ||
      configured.search ||
      configured.hash ||
      configured.username ||
      configured.password
    )
      return c.notFound();
    const target = new URL("/api/auth/callback/oidc", origin);
    target.search = new URL(c.req.url).search;
    return c.redirect(target.href, 303);
  });
}
