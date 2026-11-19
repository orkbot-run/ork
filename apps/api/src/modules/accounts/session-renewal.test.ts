// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Auth } from "@orkbot/auth";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { sessionRenewal } from "./session-renewal.js";

const sessionName = "__Secure-better-auth.session_token";
const renewed = `${sessionName}=test.signed; Path=/; Secure; HttpOnly; Max-Age=604800`;

function setup() {
  const headers = new Headers();
  headers.append("set-cookie", renewed);
  headers.append("set-cookie", "new-cookie=value; Path=/");
  const session = { user: { id: "test-user" } };
  const getSession = vi.fn(async ({ returnHeaders }: { returnHeaders?: boolean }) =>
    returnHeaders ? { response: session, headers } : session,
  );
  const auth = { api: { getSession } } as unknown as Auth;
  const sessions = sessionRenewal(auth);
  const app = new Hono();
  app.use("*", sessions.middleware);
  return { app, sessions, getSession };
}

it("appends only provided cookie names and keeps unrelated cookies in the response", async () => {
  const { app, sessions } = setup();
  app.get("/", async (c) => {
    await sessions.read(c.req.raw);
    c.req.raw = new Request(c.req.raw);
    return c.text("ok", 200, { "set-cookie": "unrelated=test; Path=/" });
  });
  const response = await app.request("/", { headers: { cookie: `${sessionName}=test.signed` } });
  expect(response.headers.getSetCookie()).toEqual(["unrelated=test; Path=/", renewed]);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("preserves a session change issued by the route", async () => {
  const { app, sessions } = setup();
  const cleared = `${sessionName}=; Path=/; Max-Age=0`;
  app.get("/", async (c) => {
    await sessions.read(c.req.raw);
    return c.text("ok", 200, { "set-cookie": cleared });
  });
  const response = await app.request("/", { headers: { cookie: `${sessionName}=test.signed` } });
  expect(response.headers.getSetCookie()).toEqual([cleared]);
});

it("rechecks long-lived requests without refreshing a cookie that cannot be delivered", async () => {
  const { sessions, getSession } = setup();
  const request = new Request("http://localhost/", { headers: { cookie: `${sessionName}=test` } });
  await expect(sessions.recheck(request)).resolves.toEqual({ user: { id: "test-user" } });
  expect(getSession).toHaveBeenCalledWith({
    headers: request.headers,
    query: { disableRefresh: true },
  });
});
