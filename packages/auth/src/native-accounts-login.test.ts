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
import type { NativePairingStore, PairingClaim, PairingReceipt } from "./native-pairing-store.js";
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
  const initializationRequired = vi.fn(async () => true);
  const consume = vi.fn(async () => ({ allowProvision: true }));
  const seen: unknown[] = [];
  const provision = vi.fn(async () => {
    seen.push(nativeLoginProof());
  });
  let ticket: PairingReceipt;
  let pairingState = "failed";
  let leaseValue = "";
  let leaseSequence = 0;
  const pairings: NativePairingStore = {
    create: vi.fn(async (value) => {
      ticket = value;
      pairingState = "pending";
      return "p".repeat(43);
    }),
    acquire: vi.fn(async (): Promise<PairingClaim> => {
      if (pairingState === "paired" || pairingState === "failed") return { state: pairingState };
      if (pairingState === "working") return { state: "pending" };
      pairingState = "working";
      leaseValue = String(++leaseSequence);
      return { state: "claimed", lease: { key: "fixture", value: leaseValue, ticket } };
    }),
    current: vi.fn(async (lease) => pairingState === "working" && lease.value === leaseValue),
    finish: vi.fn(async (lease, state) => {
      if (lease.value !== leaseValue || pairingState !== "working") return false;
      pairingState = state;
      return true;
    }),
  };
  const issue = vi.fn(async () => ({ challenge, expiresAt: Math.floor(Date.now() / 1000) + 120 }));
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
        pairingStore: pairings,
        store: {
          issue,
          bootstrapRequired: async () => true,
          initializationRequired,
          consume,
        },
      }),
    ],
  });
  const request = (path: string, body?: unknown, requestOrigin: string | null = origin) =>
    auth.handler(
      new Request(`${origin}/api/auth/native/${path}`, {
        method: ["initialization", "workspace-status"].includes(path) ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(requestOrigin ? { origin: requestOrigin } : {}),
        },
        ...(!["initialization", "workspace-status"].includes(path)
          ? { body: JSON.stringify(body) }
          : {}),
      }),
    );
  return { data, consume, provision, seen, request, auth, pairings, issue, initializationRequired };
}

describe("native login endpoint", () => {
  it("returns only an uncached public workspace state if verification is unavailable", async () => {
    const f = fixture();
    const response = await f.request("workspace-status", undefined, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ status: "unknown" });
  });

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

describe("approval-gated sessionless server pairing", () => {
  const ticket = {
    id: "a".repeat(64),
    receipt: "r".repeat(43),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  function broker(claims: Record<string, unknown> = {}) {
    const approval = { status: "pending" };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (String(url) === `${issuer}/api/server-pairings/redeem`) {
        expect(body).toEqual({ code: "ABC234", origin });
        expect(init!.headers).toEqual({ "content-type": "application/json" });
        return Response.json(ticket, { status: 202 });
      }
      if (String(url) === `${issuer}/api/server-pairings/grant`) {
        if (!body.challenge)
          return Response.json(
            { status: approval.status, expiresAt: ticket.expiresAt },
            { status: 202 },
          );
        const grant = await signed({ purpose: SERVER_PAIRING_PURPOSE, ...claims });
        return Response.json({ ...ticket, grant, expiresAt: decodeJwt(grant).exp });
      }
      if (String(url) === `${issuer}/api/server-pairings/report`)
        return Response.json({ ok: true });
      throw new Error("Unexpected offline request");
    });
    vi.stubGlobal("fetch", fetcher);
    return { fetcher, approval };
  }
  async function begin(f: ReturnType<typeof fixture>) {
    const response = await f.request("pair", {
      code: "abc-234",
      origin: "https://evil.example.test",
    });
    expect(response.status, await response.clone().text()).toBe(202);
    const result = (await response.json()) as { pending: boolean; pairingId: string };
    expect(result).toEqual({ pending: true, pairingId: "p".repeat(43) });
    expect(response.headers.get("set-cookie")).toBeNull();
    return result;
  }
  it("reads authoritative initialization state without a challenge, cookie, or session", async () => {
    const f = fixture();
    const { fetcher } = broker();
    for (const required of [true, false]) {
      f.initializationRequired.mockResolvedValue(required);
      const response = await f.request("initialization");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ required });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.data.session).toHaveLength(0);
  });
  it("refuses a new pairing after admission and fences admission during redemption", async () => {
    for (const race of [false, true]) {
      const f = fixture();
      const { fetcher } = broker();
      f.initializationRequired.mockResolvedValue(false);
      if (race) f.initializationRequired.mockResolvedValueOnce(true);
      expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
      expect(f.pairings.create).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.data.user).toHaveLength(0);
      if (race)
        expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).success).toBe(false);
      else expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("refuses a pending ticket after admission without obtaining a challenge or provisioning", async () => {
    const f = fixture();
    const { fetcher, approval } = broker();
    const pending = await begin(f);
    approval.status = "approved";
    f.initializationRequired.mockResolvedValue(false);
    expect((await f.request("pair/status", pending)).status).toBe(403);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).success).toBe(false);
  });
  it("fences admission while an approved grant is being fetched", async () => {
    const f = fixture();
    const { approval, fetcher } = broker();
    const pending = await begin(f);
    approval.status = "approved";
    f.initializationRequired
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect((await f.request("pair/status", pending)).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).success).toBe(false);
  });
  it("separates pairing authority from a normal login token or an untrusted privilege claim", async () => {
    const normal = await signed({ allowProvision: true });
    expect((await verify(normal, challenge)).allowProvision).toBeUndefined();
    await expect(verifyPairing(normal, challenge)).rejects.toThrow();
    await expect(
      verify(await signed({ purpose: SERVER_PAIRING_PURPOSE }), challenge),
    ).rejects.toThrow();
  });
  it("waits without issuing any challenge, then provisions and reports only after approval", async () => {
    const f = fixture();
    const { approval, fetcher } = broker();
    const pending = await begin(f);
    expect(f.issue).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    const status = await f.request("pair/status", pending);
    expect(status.status).toBe(202);
    expect(await status.json()).toEqual({ pending: true });
    expect(f.issue).not.toHaveBeenCalled();
    approval.status = "approved";
    const done = await f.request("pair/status", pending);
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await done.json()).toEqual({ paired: true });
    expect(done.headers.get("set-cookie")).toBeNull();
    expect(f.data.session).toHaveLength(0);
    expect(f.issue).toHaveBeenCalledOnce();
    expect(f.provision).toHaveBeenCalledOnce();
    expect(f.seen).toMatchObject([{ issuer, subject: "subject-a", allowProvision: true }]);
    expect(JSON.parse(fetcher.mock.calls[3]![1]!.body as string)).toEqual({
      id: ticket.id,
      receipt: ticket.receipt,
      challenge,
    });
    expect(JSON.parse(fetcher.mock.calls[4]![1]!.body as string)).toEqual({
      id: ticket.id,
      receipt: ticket.receipt,
      success: true,
    });
    f.initializationRequired.mockResolvedValue(false);
    const repeated = await f.request("pair/status", pending);
    expect(repeated.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it.each([null, "https://evil.example.test", "null"])(
    "rejects wrong browser origin %j before broker or DB activity",
    async (requestOrigin) => {
      const f = fixture();
      const { fetcher } = broker();
      expect((await f.request("pair", { code: "ABC234" }, requestOrigin)).status).toBe(403);
      expect(
        (await f.request("pair/status", { pairingId: "p".repeat(43) }, requestOrigin)).status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      expect(f.pairings.acquire).not.toHaveBeenCalled();
    },
  );
  it.each(["ABC23", "AAAAA0", "A".repeat(17), 234567, null])(
    "rejects invalid key %j before redemption",
    async (code) => {
      const f = fixture();
      const { fetcher } = broker();
      expect((await f.request("pair", { code })).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    { purpose: "orkbot-server-login-v1" },
    { aud: "https://evil.example.test" },
    { nonce: "wrong" },
    { email_verified: false },
  ])("rejects invalid signed pairing authorization %j before mutation", async (claims) => {
    const f = fixture();
    const { approval, fetcher } = broker(claims);
    const pending = await begin(f);
    approval.status = "approved";
    expect((await f.request("pair/status", pending)).status).toBe(403);
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.data.user).toHaveLength(0);
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).success).toBe(false);
    const calls = fetcher.mock.calls.length;
    expect((await f.request("pair/status", pending)).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it("rejects a foreign managed owner and does not report success on a provisioning error", async () => {
    for (const managed of [true, false]) {
      const f = fixture(managed ? oidcAccountSubject(issuer, "other") : undefined);
      const { approval, fetcher } = broker();
      const pending = await begin(f);
      approval.status = "approved";
      if (!managed) f.provision.mockRejectedValueOnce(new Error("Unavailable"));
      expect((await f.request("pair/status", pending)).status).toBe(403);
      expect(f.data.session).toHaveLength(0);
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).success).toBe(false);
      if (managed) expect(f.data.user).toHaveLength(0);
    }
  });
  it("serializes concurrent polls and waits for report acknowledgement", async () => {
    const f = fixture();
    const { approval, fetcher } = broker();
    const pending = await begin(f);
    approval.status = "approved";
    let acknowledge!: (response: Response) => void;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) =>
      String(url).endsWith("/report")
        ? new Promise<Response>((resolve) => {
            acknowledge = resolve;
          })
        : original(url, init),
    );
    const first = f.request("pair/status", pending);
    await vi.waitFor(() => expect(f.provision).toHaveBeenCalledOnce());
    expect((await f.request("pair/status", pending)).status).toBe(202);
    acknowledge(Response.json({ ok: true }));
    expect((await first).status).toBe(200);
    expect(f.issue).toHaveBeenCalledOnce();
  });
  it.each(["oversized", "redirect", "timeout"])(
    "rejects %s redemption without mutation",
    async (kind) => {
      const f = fixture();
      const { fetcher } = broker();
      fetcher.mockImplementationOnce(async () => {
        if (kind === "timeout") throw new DOMException("Timed out", "TimeoutError");
        return kind === "redirect"
          ? new Response(null, { status: 302 })
          : new Response("x".repeat(24 * 1024 + 1));
      });
      expect((await f.request("pair", { code: "ABC234" })).status).toBe(403);
      expect(f.consume).not.toHaveBeenCalled();
      expect(f.data.user).toHaveLength(0);
    },
  );
});
