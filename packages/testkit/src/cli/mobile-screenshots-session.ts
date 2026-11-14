// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isIP } from "node:net";
import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";

export type ScreenshotApp = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

export type ScreenshotSession = {
  origin: string;
  headers: Record<string, string>;
};

/** Keep the managed fixture's scoped session on its exact, isolated installation. */
export function scopedScreenshotApp(app: ScreenshotApp, session: ScreenshotSession): ScreenshotApp {
  const origin = new URL(session.origin);
  const privateAddress =
    ["localhost", "127.0.0.1"].includes(origin.hostname) ||
    (isIP(origin.hostname) === 4 &&
      /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(origin.hostname));
  if (
    origin.protocol !== "https:" ||
    !privateAddress ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Use an isolated HTTPS installation origin for mobile screenshots");
  const authorization = new Headers(session.headers);
  if (
    !/^Bearer \S+$/.test(authorization.get("authorization") ?? "") ||
    !authorization.get("x-orkbot-space-id") ||
    authorization.get(CLIENT_PROTOCOL_HEADER) !== String(CLIENT_PROTOCOL_VERSION)
  )
    throw new Error("Mobile screenshots need an admitted native workspace session");
  return {
    request(input, init) {
      const target = new URL(input, origin);
      if (target.origin !== origin.origin || !target.pathname.startsWith("/rpc/"))
        throw new Error("Mobile screenshot session destination mismatch");
      const headers = new Headers(init?.headers);
      headers.delete("cookie");
      for (const [name, value] of authorization) headers.set(name, value);
      return app.request(target.href, { ...init, headers, redirect: "error" });
    },
  };
}
