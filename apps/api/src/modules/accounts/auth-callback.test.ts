// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountAuthCallback } from "./auth-callback.js";

describe("native loopback OIDC callback", () => {
  const origin = "http://127.0.0.1:45173";
  it("forwards the code and state only to the configured server's auth handler", async () => {
    const app = new Hono();
    mountAuthCallback(app, `${origin}/callback`, origin);
    const response = await app.request(
      "http://untrusted.example/callback?code=fake-code&state=fake-state&iss=https%3A%2F%2Fidentity.example",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${origin}/api/auth/callback/oidc?code=fake-code&state=fake-state&iss=https%3A%2F%2Fidentity.example`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each([
    undefined,
    "https://identity.example/callback",
    "http://localhost:45173/callback",
    `${origin}/other`,
    `${origin}/callback?next=evil`,
  ])("does not expose an unconfigured callback (%s)", async (redirectURI) => {
    const app = new Hono();
    mountAuthCallback(app, redirectURI, origin);
    const response = await app.request("/callback?code=fake-code&state=fake-state");
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});
