// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync } from "node:crypto";
import { SERVER_PAIRING_PURPOSE } from "@orkbot/contracts";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, decodeJwt, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const verifyPairing = createNativeGrantVerifier({
  issuer,
  origin,
  keys,
  purpose: SERVER_PAIRING_PURPOSE,
});
afterEach(() => vi.unstubAllGlobals());
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
  const provision = vi.fn(async () => {
    seen.push(nativeLoginProof());
  });
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
        verifyPairingGrant: verifyPairing,
        provisionUser: provision,
        store: {
          issue: async () => ({ challenge, expiresAt: Math.floor(Date.now() / 1000) + 120 }),
          bootstrapRequired: async () => true,
          consume,
        },
      }),
    ],
  });
  const request = (path: string, body: unknown, requestOrigin: string | null = origin) =>
    auth.handler(
      new Request(`${origin}/api/auth/native/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(requestOrigin ? { origin: requestOrigin } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  return { data, consume, provision, seen, request, auth };
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

describe("sessionless server pairing", () => {
  const receipt = { id: "a".repeat(64), receipt: "r".repeat(43) };
  function broker(claims: Record<string, unknown> = {}) {
    const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url) === `${issuer}/api/server-pairings/redeem`) {
        const grant = await signed({ purpose: SERVER_PAIRING_PURPOSE, ...claims });
        return Response.json({ ...receipt, grant, expiresAt: decodeJwt(grant).exp });
      }
      if (String(url) === `${issuer}/api/server-pairings/report`)
        return Response.json({ ok: true });
      throw new Error("Unexpected offline request");
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  it("separates initialization authority from ordinary login tokens and ignores claimed privileges", async () => {
    const login = await signed({ allowProvision: true });
    expect((await verify(login, challenge)).allowProvision).toBeUndefined();
    await expect(verifyPairing(login, challenge)).rejects.toThrow();
    const pair = await signed({ purpose: SERVER_PAIRING_PURPOSE });
    expect(await verifyPairing(pair, challenge)).toMatchObject({ allowProvision: true });
    await expect(verify(pair, challenge)).rejects.toThrow();
  });
  it("redeems only a code at the configured issuer and provisions before reporting without a session", async () => {
    const f = fixture();
    const fetcher = broker();
    const response = await f.request("pair", {
      code: "abc-234",
      origin: "https://evil.example.test",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ paired: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.data.session).toHaveLength(0);
    expect(f.provision).toHaveBeenCalledOnce();
    expect(f.seen).toMatchObject([{ issuer, subject: "subject-a", allowProvision: true }]);
    expect(f.data.user).toHaveLength(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${issuer}/api/server-pairings/redeem`);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(init!.body as string)).toEqual({ code: "ABC234", origin, challenge });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      ...receipt,
      success: true,
    });
    expect(f.provision.mock.invocationCallOrder[0]).toBeLessThan(
      fetcher.mock.invocationCallOrder[1]!,
    );
    expect(nativeLoginProof()).toBeUndefined();
  });
  it.each([null, "https://evil.example.test", "null"])(
    "rejects browser pairing from origin %j before any broker or database work",
    async (requestOrigin) => {
      const f = fixture();
      const fetcher = broker();
      expect((await f.request("pair", { code: "ABC234" }, requestOrigin)).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.data.user).toHaveLength(0);
    },
  );
  it.each(["ABC23", "AAAAA0", "A".repeat(17), 234567, null])(
    "rejects invalid code %j before redemption",
    async (code) => {
      const f = fixture();
      const fetcher = broker();
      expect((await f.request("pair", { code })).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    { purpose: "orkbot-server-login-v1" },
    { aud: "https://evil.example.test" },
    { nonce: "wrong" },
    { email_verified: false },
  ])("refuses invalid pairing authorization before mutation: %j", async (claims) => {
    const f = fixture();
    const fetcher = broker(claims);
    expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      ...receipt,
      success: false,
    });
  });
  it("reports a refused owner claim as failure without provisioning", async () => {
    const f = fixture();
    const fetcher = broker();
    f.consume.mockRejectedValueOnce(new Error("Existing owner"));
    expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
    expect(f.data.user).toHaveLength(0);
    expect(f.provision).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).success).toBe(false);
  });
  it("never reports success when workspace provisioning fails", async () => {
    const f = fixture();
    const fetcher = broker();
    f.provision.mockRejectedValueOnce(new Error("Workspace unavailable"));
    expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
    expect(f.data.session).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).success).toBe(false);
  });
  it("enforces the managed owner before account or workspace writes", async () => {
    const f = fixture(oidcAccountSubject(issuer, "another-owner"));
    const fetcher = broker();
    expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(f.provision).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).success).toBe(false);
  });
  it("does not claim success before the broker acknowledges the provisioned server", async () => {
    const f = fixture();
    const fetcher = broker();
    let acknowledge!: (response: Response) => void;
    const acknowledgement = new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
    fetcher
      .mockImplementationOnce(async () => {
        const grant = await signed({ purpose: SERVER_PAIRING_PURPOSE });
        return Response.json({ ...receipt, grant, expiresAt: decodeJwt(grant).exp });
      })
      .mockImplementationOnce(() => acknowledgement);
    let settled = false;
    const pairing = f.request("pair", { code: "ABC234" }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(f.provision).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    acknowledge(Response.json({ ok: false }));
    const response = await pairing;
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.data.session).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string).success).toBe(false);
  });
  it.each(["oversized", "redirect", "timeout"])(
    "rejects a %s broker response without mutation",
    async (kind) => {
      const f = fixture();
      const fetcher = broker();
      fetcher.mockImplementationOnce(async () => {
        if (kind === "timeout") throw new DOMException("Timed out", "TimeoutError");
        if (kind === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.test" },
          });
        return new Response("x".repeat(24 * 1024 + 1));
      });
      expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.data.user).toHaveLength(0);
      expect(f.provision).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});
