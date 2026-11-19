// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { runAsSystem } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const nearExpirySeconds = 5 * 60;

function sessionCookie(response: Response) {
  const cookies = response.headers.getSetCookie();
  const sessionCookies = cookies.filter((cookie) => /^[^=]+\.session_token=/.test(cookie));
  expect(sessionCookies).toHaveLength(1);
  const [cookie, ...attributes] = sessionCookies[0]!.split(";");
  const maxAge = attributes.find((attribute) => attribute.trim().startsWith("Max-Age="));
  expect(Number(maxAge?.trim().slice("Max-Age=".length))).toBeGreaterThan(nearExpirySeconds);
  return cookie!;
}

describe.skipIf(!databaseUrl)("composed app session renewal", () => {
  let dataDir: string;
  let handles: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "orkbot-session-renewal-"));
    handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
    });
  });

  afterAll(async () => {
    try {
      await handles?.stop();
    } finally {
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    }
  });

  async function signUp() {
    const response = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        email: `session-renewal-${randomUUID()}@example.test`,
        password: "test-password-123",
        name: "Session tester",
      }),
    });
    expect(response.status).toBe(200);
    const cookie = sessionCookie(response);
    const signedToken = response.headers.get("set-auth-token");
    expect(signedToken).toBeTruthy();
    const { user } = (await response.json()) as { user: { id: string } };
    const expiresAt = new Date(Date.now() + nearExpirySeconds * 1000);
    const sessionId = await runAsSystem("age the Better Auth session", async () => {
      const { id } = await handles.prisma.session.findFirstOrThrow({ where: { userId: user.id } });
      await handles.prisma.session.update({ where: { id }, data: { expiresAt } });
      return id;
    });
    return {
      userId: user.id,
      sessionId,
      cookie,
      authorization: `Bearer ${signedToken}`,
      expiresAt,
    };
  }

  function rpc(procedure: string, credentials: Record<string, string>, json: unknown = {}) {
    // No Content-Length is supplied, so the body limiter reads and wraps this Request.
    return handles.app.request(`/rpc/${procedure}`, {
      method: "POST",
      headers: {
        [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
        "content-type": "application/json",
        origin,
        ...credentials,
      },
      body: JSON.stringify({ json }),
    });
  }

  async function expectRenewed(session: Awaited<ReturnType<typeof signUp>>) {
    const persisted = await runAsSystem("inspect renewed expiry", () =>
      handles.prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } }),
    );
    expect(persisted.expiresAt.getTime()).toBeGreaterThan(session.expiresAt.getTime());
  }

  async function expectMe(response: Response, userId: string) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ json: { userId } });
  }

  it.each([
    { label: "with the cookie alone", includeBearer: false },
    { label: "with the cookie and matching Bearer", includeBearer: true },
  ])("renews an aging session $label", async ({ includeBearer }) => {
    const session = await signUp();
    const response = await rpc("me", {
      cookie: session.cookie,
      ...(includeBearer ? { authorization: session.authorization } : {}),
    });
    await expectMe(response, session.userId);
    const cookie = sessionCookie(response);
    await expectRenewed(session);

    const next = await rpc("me", { cookie });
    await expectMe(next, session.userId);
    expect(next.headers.getSetCookie()).toEqual([]);
  });

  it("does not write cookies for a Bearer-only RPC", async () => {
    const session = await signUp();
    const response = await rpc("me", { authorization: session.authorization });
    await expectMe(response, session.userId);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("keeps the Bearer identity from replacing another user's browser cookie", async () => {
    const browser = await signUp();
    const bearer = await signUp();
    const response = await rpc("me", {
      cookie: browser.cookie,
      authorization: bearer.authorization,
    });
    await expectMe(response, bearer.userId);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("sends a renewed cookie in the subscription response headers", async () => {
    const session = await signUp();
    const response = await rpc(
      "notifications/subscribe",
      { cookie: session.cookie },
      { roster: true },
    );
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      sessionCookie(response);
      await expectRenewed(session);
    } finally {
      await response.body?.cancel();
    }
  });
});
