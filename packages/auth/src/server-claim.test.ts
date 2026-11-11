// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createLocalJWKSet, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createNativeGrantVerifier } from "./native-accounts-login.js";
import {
  issueServerClaim,
  serverClaimProof,
  startServerClaimWorker,
  verifyServerClaimGrant,
} from "./server-claim.js";

const issuer = "https://accounts.example.test";
const origin = "https://server.example.test";
const challenge = "a".repeat(43);
const id = "f".repeat(64);
const proofNonce = "b".repeat(43);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = createLocalJWKSet({
  keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test" }],
});

describe("server claim lifetime", () => {
  function fixture(seconds: number) {
    const tx = {
      deploymentSettings: { upsert: vi.fn(async () => ({ nativeAccountsOwnerKey: null })) },
      user: { count: vi.fn(async () => 0) },
      verification: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const db = {
      ...tx,
      $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx),
    };
    const expiresAt = Math.floor(Date.now() / 1000) + seconds;
    const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(
        { id, origin, receipt: "c".repeat(43), proofNonce, code: "23456789AB", expiresAt },
        { status: 201 },
      ),
    );
    return { tx, db: db as never, request, expiresAt };
  }

  it("requests and accepts a ten-minute code", async () => {
    const f = fixture(600);
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ code: "23456789AB", expiresAt: f.expiresAt });
    expect(JSON.parse(String(f.request.mock.calls[0]![1]!.body))).toMatchObject({
      origin,
      lifetimeSeconds: 600,
    });
    expect(f.tx.verification.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects a response exceeding the permitted lifetime", async () => {
    const f = fixture(620);
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Accounts returned an invalid authorization.");
    expect(f.tx.verification.updateMany).not.toHaveBeenCalled();
    expect(f.tx.verification.deleteMany).toHaveBeenCalledOnce();
  });

  it("retries without the lifetime field when an older Accounts server returns 400", async () => {
    const f = fixture(300);
    f.request.mockImplementationOnce(
      async () => new Response("Invalid claim request", { status: 400 }),
    );
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).resolves.toEqual({ code: "23456789AB", expiresAt: f.expiresAt });
    expect(f.request).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(f.request.mock.calls[0]![1]!.body));
    const second = JSON.parse(String(f.request.mock.calls[1]![1]!.body));
    expect(first.lifetimeSeconds).toBe(600);
    expect(second).toEqual({ origin, challenge: first.challenge });
  });

  it.each([403, 429, 500, 503])("does not retry other Accounts errors (%s)", async (status) => {
    const f = fixture(300);
    f.request.mockImplementationOnce(async () => Response.json({}, { status }));
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("rejects a long lifetime from a legacy fallback", async () => {
    const f = fixture(320);
    f.request.mockImplementationOnce(async () => new Response(null, { status: 400 }));
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Accounts returned an invalid authorization.");
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("does not retry a network failure", async () => {
    const f = fixture(300);
    f.request.mockRejectedValueOnce(new Error("Network unavailable"));
    await expect(
      issueServerClaim(f.db, {
        issuer,
        origin,
        bootstrapSecret: "s".repeat(43),
        request: f.request as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Network unavailable");
    expect(f.request).toHaveBeenCalledOnce();
  });
});

function signed(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: origin,
    sub: "owner",
    nonce: challenge,
    jti: randomUUID(),
    purpose: "orkbot-server-claim-v1",
    iat: now,
    exp: now + 60,
    ...changes,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(privateKey);
}

describe("server authorization grant", () => {
  it("verifies a scoped claim without accepting it as a public login grant", async () => {
    const grant = await signed();
    expect(await verifyServerClaimGrant(grant, { issuer, origin, challenge, keys })).toMatchObject({
      sub: "owner",
    });
    await expect(
      createNativeGrantVerifier({ issuer, origin, keys })(grant, challenge),
    ).rejects.toThrow();
  });
  it("accepts an organization only when it is present in the signed claim as a UUID", async () => {
    const organizationId = randomUUID();
    const grant = await signed({ organization_id: organizationId });
    expect(await verifyServerClaimGrant(grant, { issuer, origin, challenge, keys })).toMatchObject({
      sub: "owner",
      organization_id: organizationId,
    });
    await expect(
      verifyServerClaimGrant(await signed({ organization_id: "not-an-organization" }), {
        issuer,
        origin,
        challenge,
        keys,
      }),
    ).rejects.toThrow();
  });
  it.each([
    { aud: "https://other.example.test" },
    { aud: [origin, "https://other.example.test"] },
    { nonce: "wrong" },
    { purpose: "orkbot-server-login-v1" },
    { email: "owner@example.test" },
    { jti: "not-a-uuid" },
    { sub: "" },
    { organization_id: null },
    { organization_id: ["00000000-0000-4000-8000-000000000001"] },
    { exp: Math.floor(Date.now() / 1000) - 30 },
  ])("rejects a misbound or invalid grant: %j", async (changes) => {
    await expect(
      verifyServerClaimGrant(await signed(changes), { issuer, origin, challenge, keys }),
    ).rejects.toThrow();
  });
});

describe("server authorization proof", () => {
  const bootstrapSecret = "s".repeat(43);
  const expiresAt = Math.floor(Date.now() / 1000) + 120;
  const receipt = "c".repeat(43);
  const saved = {
    state: "pending",
    id,
    proofNonce,
    receipt,
    challenge,
    expiresAt,
    bootstrapMac: createHmac("sha256", bootstrapSecret)
      .update(
        JSON.stringify([origin, "pending", id, receipt, proofNonce, challenge, expiresAt, null]),
      )
      .digest("hex"),
  };
  function prisma(value: object = saved, owner: string | null = null) {
    return {
      verification: {
        findUnique: vi.fn(async () => ({
          value: JSON.stringify(value),
          expiresAt: new Date(Date.now() + 60_000),
        })),
      },
      deploymentSettings: { findUnique: vi.fn(async () => ({ nativeAccountsOwnerKey: owner })) },
      user: { count: vi.fn(async () => 0) },
    } as never;
  }
  it("reveals only the matching pending proof and never creates an attempt", async () => {
    const db = prisma();
    expect(await serverClaimProof(db, id, proofNonce, { origin, bootstrapSecret })).toEqual({
      id,
      proofNonce,
      status: "pending",
      organizationBinding: true,
    });
    expect(await serverClaimProof(db, id, "z".repeat(43), { origin, bootstrapSecret })).toBeNull();
    expect(
      await serverClaimProof(db, id, proofNonce, { origin, bootstrapSecret: "x".repeat(43) }),
    ).toBeNull();
    expect(
      await serverClaimProof(prisma(saved, "claimed-owner"), id, proofNonce, {
        origin,
        bootstrapSecret,
      }),
    ).toMatchObject({ status: "pending" });
  });
  it("preserves the claimed proof after owner binding for report recovery", async () => {
    const grantId = randomUUID();
    const claimed = {
      ...saved,
      state: "claimed",
      grantId,
      bootstrapMac: createHmac("sha256", bootstrapSecret)
        .update(
          JSON.stringify([
            origin,
            "claimed",
            id,
            receipt,
            proofNonce,
            challenge,
            expiresAt,
            grantId,
          ]),
        )
        .digest("hex"),
    };
    expect(
      await serverClaimProof(
        prisma({ ...saved, state: "claimed", grantId }, "claimed-owner"),
        id,
        proofNonce,
        { origin, bootstrapSecret },
      ),
    ).toBeNull();
    expect(
      await serverClaimProof(prisma(claimed, "claimed-owner"), id, proofNonce, {
        origin,
        bootstrapSecret,
      }),
    ).toEqual({ id, proofNonce, status: "claimed", grantId, organizationBinding: true });
  });
});

describe("server claim worker", () => {
  it("checks for new claims at the idle interval after startup", async () => {
    vi.useFakeTimers();
    const findUnique = vi.fn(async () => null);
    const stop = startServerClaimWorker({ verification: { findUnique } } as never, {
      issuer,
      origin,
      bootstrapSecret: "s".repeat(43),
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(findUnique).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(findUnique).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(findUnique).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });
});
