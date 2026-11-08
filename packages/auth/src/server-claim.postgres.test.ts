// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@orkbot/db";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createLocalJWKSet, SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeAccountsLogin, nativeLoginStore } from "./native-accounts-login.js";
import { oidcAccountSubject } from "./oidc.js";
import { issueServerClaim, processServerClaim, serverClaimProof } from "./server-claim.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.COPY_TEST_DATABASE);
const database = enabled
  ? createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 8 })
  : undefined;
const prisma = database?.prisma;
const issuer = "https://accounts.example.test";
const origin = "https://server.example.test";
const bootstrapSecret = "s".repeat(43);
const receipt = "r".repeat(43);
const proofNonce = "p".repeat(43);
const id = "a".repeat(64);
const code = "ABCDEFGHJK";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keys = createLocalJWKSet({
  keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "test" }],
});
const system = <T>(run: () => Promise<T>) => runAsSystem("server claim PostgreSQL test", run);

function broker(claimId = id, nonce = proofNonce) {
  let challenge = "";
  let approval = false;
  let failReport = false;
  const reports: boolean[] = [];
  let hold: Promise<void> | undefined;
  let onStarted: (() => void) | undefined;
  const grantId = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (path.endsWith("/issue")) {
      challenge = String(body.challenge);
      expect(body.origin).toBe(origin);
      return Response.json(
        { id: claimId, origin, receipt, proofNonce: nonce, code, expiresAt },
        { status: 201 },
      );
    }
    expect(body).toMatchObject({ id: claimId, receipt });
    if (path.endsWith("/poll")) {
      if (!approval) return Response.json({ status: "pending", expiresAt }, { status: 202 });
      onStarted?.();
      if (hold) await hold;
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 60;
      const grant = await new SignJWT({
        purpose: "orkbot-server-claim-v1",
        iss: issuer,
        aud: origin,
        sub: "owner",
        nonce: challenge,
        jti: grantId,
        iat: now,
        exp,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .sign(privateKey);
      return Response.json({ id: claimId, grant, expiresAt: exp });
    }
    if (path.endsWith("/report")) {
      reports.push(body.success as boolean);
      return Response.json({ ok: !failReport }, { status: failReport ? 503 : 200 });
    }
    throw new Error("Unexpected endpoint");
  }) as typeof fetch;
  return {
    request,
    reports,
    grantId,
    approve: () => {
      approval = true;
    },
    failReport: (value: boolean) => {
      failReport = value;
    },
    holdPoll: () => {
      let release!: () => void;
      let started!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      onStarted = started;
      return { started: waiting, release };
    },
  };
}

describe.skipIf(!enabled)("durable server authorization", () => {
  beforeEach(async () =>
    system(async () => {
      await prisma!.verification.deleteMany({
        where: {
          OR: [
            { identifier: { startsWith: "native-server-claim:" } },
            { identifier: { startsWith: "native-login-" } },
          ],
        },
      });
      await prisma!.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: { nativeAccountsOwnerKey: null },
      });
      await prisma!.organization.deleteMany({});
      await prisma!.user.deleteMany({ where: { email: { endsWith: "@example.test" } } });
    }),
  );
  afterAll(async () => {
    await database?.pool.end();
  });

  it("reports a lost owner race and retries the failure after interruption", async () =>
    system(async () => {
      const service = broker();
      const options = { issuer, origin, bootstrapSecret, request: service.request, keys };
      await issueServerClaim(prisma!, options);
      service.approve();
      const held = service.holdPoll();
      const processing = processServerClaim(prisma!, options);
      await held.started;
      await prisma!.deploymentSettings.update({
        where: { id: "default" },
        data: { nativeAccountsOwnerKey: "link-owner" },
      });
      held.release();
      await processing;
      expect(
        await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret }),
      ).toBeNull();
      service.failReport(true);
      await expect(processServerClaim(prisma!, options)).rejects.toThrow();
      service.failReport(false);
      await processServerClaim(prisma!, options);
      await processServerClaim(prisma!, options);
      expect(service.reports).toEqual([false, false]);
      expect(
        (await prisma!.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }))
          .nativeAccountsOwnerKey,
      ).toBe("link-owner");
    }));

  it("binds only the owner, persists proof and retries report after interruption", async () =>
    system(async () => {
      const service = broker();
      const options = { origin, issuer, bootstrapSecret, request: service.request };
      const issued = await issueServerClaim(prisma!, options);
      expect(issued.code).toBe(code);
      const row = await prisma!.verification.findFirstOrThrow({
        where: { identifier: "native-server-claim:active" },
      });
      expect(row.value).not.toContain(code);
      expect(await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret })).toEqual({
        id,
        proofNonce,
        status: "pending",
      });
      expect(
        await serverClaimProof(prisma!, id, "z".repeat(43), { origin, bootstrapSecret }),
      ).toBeNull();
      const auth = betterAuth({
        baseURL: origin,
        secret: "offline-test-secret-with-at-least-32-characters",
        database: memoryAdapter({ user: [], account: [], session: [], verification: [] }),
        plugins: [nativeAccountsLogin(prisma!, { origin, issuer, bootstrapSecret })],
      });
      const publicProof = await auth.handler(
        new Request(`${origin}/api/auth/native/claim-proof`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, proofNonce }),
        }),
      );
      expect(publicProof.status).toBe(200);
      expect(await publicProof.json()).toEqual({ id, proofNonce, status: "pending" });
      expect(publicProof.headers.get("set-cookie")).toBeNull();
      const injected = await auth.handler(
        new Request(`${origin}/api/auth/native/claim-proof`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, proofNonce, grant: "forged" }),
        }),
      );
      expect(injected.status).toBe(404);
      expect(
        (await prisma!.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }))
          .nativeAccountsOwnerKey,
      ).toBeNull();
      await processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: service.request,
        keys,
      });
      service.approve();
      const held = service.holdPoll();
      const first = processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: service.request,
        keys,
      });
      await held.started;
      await processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: service.request,
        keys,
      });
      held.release();
      await first;
      expect(
        (await prisma!.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }))
          .nativeAccountsOwnerKey,
      ).toBe(oidcAccountSubject(issuer, "owner"));
      expect(await prisma!.user.count()).toBe(0);
      expect(await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret })).toEqual({
        id,
        proofNonce,
        status: "claimed",
        grantId: service.grantId,
      });
      const claimedProof = await auth.handler(
        new Request(`${origin}/api/auth/native/claim-proof`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, proofNonce }),
        }),
      );
      expect(await claimedProof.json()).toEqual({
        id,
        proofNonce,
        status: "claimed",
        grantId: service.grantId,
      });
      await expect(issueServerClaim(prisma!, options)).rejects.toThrow();
      service.failReport(true);
      await expect(
        processServerClaim(prisma!, {
          issuer,
          origin,
          bootstrapSecret,
          request: service.request,
          keys,
        }),
      ).rejects.toThrow();
      expect(
        await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret }),
      ).toMatchObject({
        status: "claimed",
        grantId: service.grantId,
      });
      service.failReport(false);
      await processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: service.request,
        keys,
      });
      const calls = vi.mocked(service.request).mock.calls.length;
      await processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: service.request,
        keys,
      });
      expect(vi.mocked(service.request).mock.calls).toHaveLength(calls);
      expect(
        await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret }),
      ).toMatchObject({
        status: "claimed",
        grantId: service.grantId,
      });
    }));

  it("allows only one winner when a bootstrap link and fallback grant race", async () =>
    system(async () => {
      const service = broker();
      await issueServerClaim(prisma!, {
        origin,
        issuer,
        bootstrapSecret,
        request: service.request,
      });
      service.approve();
      const login = nativeLoginStore(prisma!, { bootstrapSecret });
      const challenge = await login.issue(origin);
      const identity = {
        issuer,
        subject: "link-owner",
        jwtId: randomUUID(),
        expiresAt: Math.floor(Date.now() / 1000) + 60,
        email: "link-owner@example.test",
        name: "Link owner",
      };
      const outcomes = await Promise.allSettled([
        processServerClaim(prisma!, {
          issuer,
          origin,
          bootstrapSecret,
          request: service.request,
          keys,
        }),
        login.consume({ origin, challenge: challenge.challenge, identity, bootstrapSecret }),
      ]);
      const owner = (
        await prisma!.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } })
      ).nativeAccountsOwnerKey;
      expect([
        oidcAccountSubject(issuer, "owner"),
        oidcAccountSubject(issuer, "link-owner"),
      ]).toContain(owner);
      const proof = await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret });
      if (owner === oidcAccountSubject(issuer, "owner")) {
        expect(outcomes[0]?.status).toBe("fulfilled");
        expect(outcomes[1]?.status).toBe("rejected");
        expect(proof).toMatchObject({ status: "claimed" });
      } else {
        expect(outcomes[1]?.status).toBe("fulfilled");
        expect(proof).toBeNull();
      }
    }));

  it("recovers an expired worker lease and refuses an older regenerated proof", async () =>
    system(async () => {
      const first = broker();
      await issueServerClaim(prisma!, { origin, issuer, bootstrapSecret, request: first.request });
      const nextId = "b".repeat(64);
      const nextNonce = "q".repeat(43);
      const next = broker(nextId, nextNonce);
      await issueServerClaim(prisma!, { origin, issuer, bootstrapSecret, request: next.request });
      expect(
        await serverClaimProof(prisma!, id, proofNonce, { origin, bootstrapSecret }),
      ).toBeNull();
      expect(
        await serverClaimProof(prisma!, nextId, nextNonce, { origin, bootstrapSecret }),
      ).toMatchObject({ status: "pending" });
      const record = await prisma!.verification.findFirstOrThrow({
        where: { identifier: "native-server-claim:active" },
      });
      const saved = JSON.parse(record.value) as Record<string, unknown>;
      await prisma!.verification.update({
        where: { id: record.id },
        data: { value: JSON.stringify({ ...saved, leaseId: "stale", leaseUntil: Date.now() - 1 }) },
      });
      next.approve();
      await processServerClaim(prisma!, {
        issuer,
        origin,
        bootstrapSecret,
        request: next.request,
        keys,
      });
      expect(
        await serverClaimProof(prisma!, nextId, nextNonce, { origin, bootstrapSecret }),
      ).toMatchObject({ status: "claimed", grantId: next.grantId });
    }));
});
