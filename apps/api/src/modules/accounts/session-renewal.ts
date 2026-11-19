// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Auth } from "@orkbot/auth";
import type { MiddlewareHandler } from "hono";
import { parse as parseCookies } from "hono/utils/cookie";

function cookieName(header: string) {
  return header.slice(0, header.indexOf("=")).trim();
}

export function sessionRenewal(auth: Pick<Auth, "api" | "$context">) {
  const pending = new WeakMap<Request, string[]>();

  const middleware: MiddlewareHandler = async (c, next) => {
    const initial = c.req.raw;
    await next();
    const cookies = [...(pending.get(initial) ?? [])];
    if (c.req.raw !== initial) cookies.push(...(pending.get(c.req.raw) ?? []));
    if (cookies.length === 0) return;

    // A route may rotate or clear a cookie itself. Its result takes precedence.
    const setNames = new Set(c.res.headers.getSetCookie().map(cookieName));
    for (const cookie of cookies) {
      const name = cookieName(cookie);
      if (setNames.has(name)) continue;
      c.header("set-cookie", cookie, { append: true });
      c.header("cache-control", "no-store");
      setNames.add(name);
    }
  };

  const read = async (request: Request) => {
    const { response, headers } = await auth.api.getSession({
      headers: request.headers,
      returnHeaders: true,
    });
    const incoming = request.headers.get("cookie");
    const outgoing = headers.getSetCookie();
    if (!response?.user || !incoming || outgoing.length === 0) return response;

    const provided = parseCookies(incoming);
    if (request.headers.has("authorization")) {
      // Better Auth gives a signed bearer priority over the cookie. Never copy a
      // different bearer session into the browser, even when the names match.
      const name = (await auth.$context).authCookies.sessionToken.name;
      const renewed = outgoing.find((cookie) => cookieName(cookie) === name);
      if (!renewed || !provided[name] || parseCookies(renewed, name)[name] !== provided[name])
        return response;
    }

    const cookies = outgoing.filter((cookie) => Object.hasOwn(provided, cookieName(cookie)));
    if (cookies.length > 0) pending.set(request, [...(pending.get(request) ?? []), ...cookies]);
    return response;
  };

  // After streaming starts there is no way to return a new cookie to the client.
  const recheck = (request: Request) =>
    auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } });

  return { middleware, read, recheck };
}
