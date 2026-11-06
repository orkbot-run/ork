// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  createNativeGrantVerifier,
  nativeAccountsLogin,
  nativeLoginProof,
} from "./native-accounts-login.js";
import { oidcAccountSubject } from "./oidc.js";

const issuer = "https://accounts.example.test";
const origin = "https://server.example.test";
const challenge = "x".repeat(43);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = createLocalJWKSet({
  keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test" }],
});
const verify = createNativeGrantVerifier({ issuer, origin, keys });
function signed(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: origin,
    sub: "subject-a",
    email: "owner@example.test",
    email_verified: true,
    name: "Owner",
    nonce: challenge,
    jti: "unique-proof-for-test",
    purpose: "orkbot-server-login-v1",
    iat: now,
    exp: now + 60,
    ...changes,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(privateKey);
}

describe("native Accounts signed grants", () => {
  it("verifies an audience-bound sixty-second identity", async () => {
    expect(await verify(await signed(), challenge)).toMatchObject({
      issuer,
      subject: "subject-a",
      email: "owner@example.test",
      jwtId: "unique-proof-for-test",
    });
    expect(nativeLoginProof()).toBeUndefined();
  });
  it.each([
    { aud: "https://different.example.test" },
    { aud: [origin, "https://different.example.test"] },
    { iss: "https://other-accounts.example.test" },
    { purpose: "id-token" },
    { nonce: "wrong" },
    { sub: "" },
    { jti: "" },
    { email_verified: false },
    { exp: Math.floor(Date.now() / 1000) - 60 },
    { exp: Math.floor(Date.now() / 1000) + 3600 },
    { iat: Math.floor(Date.now() / 1000) + 100 },
  ])("rejects a proof with invalid security claims %j", async (claims) => {
    await expect(verify(await signed(claims), challenge)).rejects.toThrow();
  });
  it("rejects malformed and tampered tokens", async () => {
    await expect(verify("not-a-token", challenge)).rejects.toThrow();
    const token = await signed();
    await expect(verify(`${token.slice(0, -8)}tampered`, challenge)).rejects.toThrow();
  });
});

function fixture(expectedOwnerKey?: string) {
  const data: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
  };
  const consume = vi.fn(async () => ({ allowProvision: true }));
  const seen: unknown[] = [];
  const auth = betterAuth({
    baseURL: origin,
    secret: "offline-native-login-secret-at-least-32-characters",
    database: memoryAdapter(data),
    databaseHooks: {
      session: {
        create: {
          before: async () => {
            seen.push(nativeLoginProof());
          },
        },
      },
    },
    plugins: [
      nativeAccountsLogin({} as never, {
        origin,
        issuer,
        expectedOwnerKey,
        verifyGrant: verify,
        store: {
          issue: async () => ({ challenge, expiresAt: Math.floor(Date.now() / 1000) + 120 }),
          bootstrapRequired: async () => true,
          consume,
        },
      }),
    ],
  });
  const request = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${origin}/api/auth/native/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      }),
    );
  return { data, consume, seen, request, auth };
}

describe("native login endpoint", () => {
  it("issues a challenge without exposing installation secrets", async () => {
    const f = fixture();
    const response = await f.request("challenge", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ challenge, bootstrapRequired: true });
  });
  it("creates a normal local session from the verified identity, with request-local provenance", async () => {
    const f = fixture();
    const response = await f.request("complete", {
      challenge,
      grant: await signed(),
      bootstrapSecret: "setup",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token=");
    expect(f.data.user).toHaveLength(1);
    expect(f.data.account).toMatchObject([
      { providerId: "oidc", accountId: oidcAccountSubject(issuer, "subject-a") },
    ]);
    expect(f.seen).toMatchObject([{ issuer, subject: "subject-a", allowProvision: true }]);
    expect(nativeLoginProof()).toBeUndefined();
    const session = await f.auth.api.getSession({
      headers: new Headers({ cookie: response.headers.get("set-cookie")! }),
    });
    expect(session?.user.id).toBe(f.data.user![0]!.id);
  });
  it("does not write an account when the expected managed identity differs", async () => {
    const f = fixture(oidcAccountSubject(issuer, "subject-b"));
    expect((await f.request("complete", { challenge, grant: await signed() })).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(f.data.account).toHaveLength(0);
  });
  it("refuses an invalid or already consumed challenge before any account writes", async () => {
    const f = fixture();
    f.consume.mockRejectedValueOnce(new Error("consumed"));
    expect(
      (await f.request("complete", { challenge, grant: await signed() })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.data.user).toHaveLength(0);
  });
});
