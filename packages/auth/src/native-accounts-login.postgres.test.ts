// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SERVER_PAIRING_PURPOSE } from "@orkbot/contracts";
import { bootstrapUserSpace, createDb, runAsSystem } from "@orkbot/db";
import { decodeJwt, SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";
import { nativeLoginStore } from "./native-accounts-login.js";
import { nativePairingStore } from "./native-pairing-store.js";
import { oidcAccountSubject } from "./oidc.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.COPY_TEST_DATABASE);
const database = enabled
  ? createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 8 })
  : undefined;
const prisma = database?.prisma;
const origin = "https://selfhost.example.test";
const issuer = "https://accounts.example.test";
const secret = "offline-bootstrap-secret-with-at-least-32-characters";
const identity = (subject: string, jwtId = randomUUID()) => ({
  issuer,
  subject,
  jwtId,
  email: `${subject}@example.test`,
  name: subject,
  expiresAt: Math.floor(Date.now() / 1000) + 60,
});
const system = <T>(run: () => Promise<T>) => runAsSystem("native login PostgreSQL test", run);

describe.skipIf(!enabled)("persistent native login authorization", () => {
  beforeEach(async () =>
    system(async () => {
      await prisma!.verification.deleteMany({
        where: {
          OR: [
            { identifier: { startsWith: "native-login-" } },
            { identifier: { startsWith: "native-pairing:" } },
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

  it("atomically admits only one first owner across independent store instances", async () =>
    system(async () => {
      const a = nativeLoginStore(prisma!, { bootstrapSecret: secret });
      const b = nativeLoginStore(prisma!, { bootstrapSecret: secret });
      const ca = await a.issue(origin);
      const cb = await b.issue(origin);
      const subjects = [identity("owner-a"), identity("owner-b")];
      const results = await Promise.allSettled([
        a.consume({
          origin,
          challenge: ca.challenge,
          identity: subjects[0]!,
          bootstrapSecret: secret,
        }),
        b.consume({
          origin,
          challenge: cb.challenge,
          identity: subjects[1]!,
          bootstrapSecret: secret,
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = subjects[results.findIndex((result) => result.status === "fulfilled")]!;
      expect(
        await prisma!.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { nativeAccountsOwnerKey: true },
        }),
      ).toEqual({ nativeAccountsOwnerKey: oidcAccountSubject(issuer, winner.subject) });
      const next = await a.issue(origin);
      await expect(
        a.consume({
          origin,
          challenge: next.challenge,
          identity: identity("third-owner"),
          bootstrapSecret: secret,
        }),
      ).rejects.toThrow();
      expect(await a.bootstrapRequired()).toBe(false);
    }));

  it("atomically claims one first owner from concurrent verified pairing grants without a secret", async () =>
    system(async () => {
      const stores = [nativeLoginStore(prisma!, {}), nativeLoginStore(prisma!, {})];
      const claims = await Promise.all(
        stores.map(async (store, index) => ({
          origin,
          ...(await store.issue(origin)),
          identity: { ...identity(`paired-${index}`), allowProvision: true },
        })),
      );
      const results = await Promise.allSettled(
        stores.map((store, index) => store.consume(claims[index]!)),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = claims[results.findIndex((result) => result.status === "fulfilled")]!.identity;
      expect(
        (await prisma!.deploymentSettings.findUnique({ where: { id: "default" } }))
          ?.nativeAccountsOwnerKey,
      ).toBe(oidcAccountSubject(issuer, winner.subject));
      expect(await prisma!.user.count()).toBe(0);
    }));

  it("does not consume a challenge or bind an owner after a wrong bootstrap secret", async () =>
    system(async () => {
      const store = nativeLoginStore(prisma!, { bootstrapSecret: secret });
      const c = await store.issue(origin);
      const user = identity("owner-a");
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: user, bootstrapSecret: "wrong" }),
      ).rejects.toThrow();
      expect(await store.bootstrapRequired()).toBe(true);
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: user, bootstrapSecret: secret }),
      ).resolves.toEqual({ allowProvision: true });
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: user, bootstrapSecret: secret }),
      ).rejects.toThrow();
    }));

  it("rejects JWT-ID reuse across challenges and preserves an unconsumed challenge on rollback", async () =>
    system(async () => {
      const store = nativeLoginStore(prisma!, { bootstrapSecret: secret });
      const user = identity("owner-a");
      const first = await store.issue(origin);
      await store.consume({
        origin,
        challenge: first.challenge,
        identity: user,
        bootstrapSecret: secret,
      });
      const second = await store.issue(origin);
      await expect(
        store.consume({ origin, challenge: second.challenge, identity: user }),
      ).rejects.toThrow();
      await expect(
        store.consume({ origin, challenge: second.challenge, identity: identity("owner-a") }),
      ).resolves.toEqual({ allowProvision: true });
    }));

  it("binds managed local servers to their expected central identity without bootstrap credentials", async () =>
    system(async () => {
      const store = nativeLoginStore(prisma!, {
        expectedOwnerKey: oidcAccountSubject(issuer, "owner-a"),
      });
      expect(await store.bootstrapRequired()).toBe(false);
      const c = await store.issue(origin);
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: identity("owner-b") }),
      ).rejects.toThrow();
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: identity("owner-a") }),
      ).resolves.toEqual({ allowProvision: true });
    }));

  it("does not let a bootstrap secret take over an existing admitted OIDC account", async () =>
    system(async () => {
      const userId = randomUUID();
      await prisma!.user.create({
        data: { id: userId, name: "Existing", email: "existing@example.test", emailVerified: true },
      });
      await prisma!.account.create({
        data: {
          id: randomUUID(),
          providerId: "oidc",
          accountId: oidcAccountSubject(issuer, "existing"),
          userId,
        },
      });
      await bootstrapUserSpace(
        prisma!,
        { id: userId },
        { signupsEnabled: "true", signupAllowlist: "" },
      );
      const store = nativeLoginStore(prisma!, { bootstrapSecret: secret });
      expect(await store.bootstrapRequired()).toBe(false);
      const c = await store.issue(origin);
      await expect(
        store.consume({
          origin,
          challenge: c.challenge,
          identity: identity("stranger"),
          bootstrapSecret: secret,
        }),
      ).rejects.toThrow();
      await expect(
        store.consume({ origin, challenge: c.challenge, identity: identity("existing") }),
      ).resolves.toEqual({ allowProvision: false });
    }));
  it("preserves admitted credential-only users when bootstrap or managed ownership is configured", async () =>
    system(async () => {
      const userId = randomUUID();
      await prisma!.user.create({
        data: { id: userId, name: "Existing", email: "existing@example.test", emailVerified: true },
      });
      await prisma!.account.create({
        data: { id: randomUUID(), providerId: "credential", accountId: userId, userId },
      });
      await bootstrapUserSpace(
        prisma!,
        { id: userId },
        { signupsEnabled: "true", signupAllowlist: "" },
      );
      const stores = [
        nativeLoginStore(prisma!, { bootstrapSecret: secret }),
        nativeLoginStore(prisma!, { expectedOwnerKey: oidcAccountSubject(issuer, "owner-a") }),
      ];
      for (const store of stores) {
        expect(await store.initializationRequired()).toBe(false);
        const c = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: c.challenge,
            identity: identity("owner-a"),
            bootstrapSecret: secret,
          }),
        ).rejects.toThrow();
        const pairing = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: pairing.challenge,
            identity: { ...identity("owner-a"), allowProvision: true },
          }),
        ).rejects.toThrow();
      }
      expect(await prisma!.user.count()).toBe(1);
      expect(await prisma!.account.count()).toBe(1);
      expect(
        (await prisma!.deploymentSettings.findUnique({ where: { id: "default" } }))
          ?.nativeAccountsOwnerKey,
      ).toBeNull();
    }));
  it("publishes sessionless initialization state only after actual admission, including partial-owner recovery", async () =>
    system(async () => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const authEnv = {
        secret: "offline-initialization-state-secret-at-least-32-characters",
        baseURL: origin,
        webOrigin: origin,
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "",
        nativeAccounts: { issuer },
      };
      const auth = createAuth(prisma!, authEnv);
      const state = async (handler = auth.handler) => {
        const response = await handler(new Request(`${origin}/api/auth/native/initialization`));
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.getSetCookie()).toEqual([]);
        return response.json();
      };
      try {
        expect(await state()).toEqual({ required: true });
        const store = nativeLoginStore(prisma!, {});
        const signedOwner = { ...identity("partial-owner"), allowProvision: true };
        const first = await store.issue(origin);
        await store.consume({ origin, challenge: first.challenge, identity: signedOwner });
        expect(await store.bootstrapRequired()).toBe(false);
        expect(await state()).toEqual({ required: true });
        // A failed provision can retry the same verified owner while no workspace exists.
        const retry = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: retry.challenge,
            identity: { ...identity("partial-owner"), allowProvision: true },
          }),
        ).resolves.toEqual({ allowProvision: true });
        const userId = randomUUID();
        await prisma!.user.create({
          data: {
            id: userId,
            name: "Partial",
            email: "partial-owner@example.test",
            emailVerified: true,
          },
        });
        await prisma!.account.create({
          data: {
            id: randomUUID(),
            userId,
            providerId: "oidc",
            accountId: oidcAccountSubject(issuer, "partial-owner"),
          },
        });
        expect(await state()).toEqual({ required: true });
        await bootstrapUserSpace(
          prisma!,
          { id: userId },
          { signupsEnabled: "true", signupAllowlist: "" },
        );
        expect(await state()).toEqual({ required: false });
        const freshProcess = createAuth(prisma!, authEnv);
        try {
          expect(await state(freshProcess.handler)).toEqual({ required: false });
        } finally {
          freshProcess.disposeOidcDiscovery();
        }
        const refused = await auth.handler(
          new Request(`${origin}/api/auth/native/pair`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ code: "ABC234" }),
          }),
        );
        expect(refused.status).toBe(403);
        expect(fetcher).not.toHaveBeenCalled();
        const pairing = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: pairing.challenge,
            identity: { ...identity("partial-owner"), allowProvision: true },
          }),
        ).rejects.toThrow();
        // Existing ordinary native login remains valid after the browser entry closes.
        const login = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: login.challenge,
            identity: identity("partial-owner"),
          }),
        ).resolves.toEqual({ allowProvision: true });
        expect(await prisma!.session.count()).toBe(0);
      } finally {
        auth.disposeOidcDiscovery();
        vi.unstubAllGlobals();
      }
    }));

  it("leases one poll across processes and fences interrupted exchanges without holding a transaction", async () =>
    system(async () => {
      const stores = [nativePairingStore(prisma!), nativePairingStore(prisma!)];
      const handle = await stores[0]!.create({
        id: "a".repeat(64),
        receipt: "r".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      const row = await prisma!.verification.findFirst({
        where: { identifier: { startsWith: "native-pairing:" } },
      });
      expect(row!.id).not.toContain(handle);
      expect(row!.value).not.toContain(handle);
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) => stores[i % 2]!.acquire(handle)),
      );
      expect(claims.filter((claim) => claim.state === "claimed")).toHaveLength(1);
      const first = claims.find((claim) => claim.state === "claimed")!;
      if (first.state !== "claimed") throw new Error("Missing lease");
      expect(await stores[0]!.finish(first.lease, "pending")).toBe(true);
      const second = await stores[1]!.acquire(handle);
      if (second.state !== "claimed") throw new Error("Missing replacement lease");
      expect(await stores[0]!.current(first.lease)).toBe(false);
      expect(await stores[0]!.finish(first.lease, "paired")).toBe(false);
      const interrupted = { ...JSON.parse(second.lease.value), leaseUntil: Date.now() - 1 };
      await prisma!.verification.update({
        where: { id: second.lease.key },
        data: { value: JSON.stringify(interrupted) },
      });
      expect(await stores[0]!.acquire(handle)).toEqual({ state: "failed" });
      expect(await stores[1]!.current(second.lease)).toBe(false);
      expect(await stores[1]!.finish(second.lease, "paired")).toBe(false);
      expect(await stores[0]!.acquire(handle)).toEqual({ state: "failed" });
      const expiring = await stores[0]!.create({
        id: "b".repeat(64),
        receipt: "s".repeat(43),
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      const expiringLease = await stores[0]!.acquire(expiring);
      if (expiringLease.state !== "claimed") throw new Error("Missing expiry lease");
      await prisma!.verification.update({
        where: { id: expiringLease.lease.key },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      expect(await stores[1]!.acquire(expiring)).toEqual({ state: "failed" });
      expect(await stores[0]!.current(expiringLease.lease)).toBe(false);
    }));

  it("initializes only a verified paired owner without a browser session, then admits ordinary native login", async () =>
    system(async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = {
        ...publicKey.export({ format: "jwk" }),
        kid: "pair-pg",
        alg: "RS256",
        use: "sig",
      };
      let subject = "paired-owner";
      let purpose = "orkbot-server-login-v1";
      let jwtId = randomUUID();
      const reports: boolean[] = [];
      let approved = false;
      const ticketExpiry = Math.floor(Date.now() / 1000) + 300;
      const sign = async (nonce: string, grantPurpose = purpose) => {
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({
          iss: issuer,
          aud: origin,
          sub: subject,
          nonce,
          jti: jwtId,
          purpose: grantPurpose,
          iat: now,
          exp: now + 60,
          email: `${subject}@example.test`,
          email_verified: true,
          name: "Paired Owner",
          allowProvision: true,
        })
          .setProtectedHeader({ alg: "RS256", kid: "pair-pg" })
          .sign(privateKey);
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input) === `${issuer}/api/auth/jwks`) return Response.json({ keys: [jwk] });
          if (String(input) === `${issuer}/api/server-pairings/redeem`) {
            const body = JSON.parse(init!.body as string);
            expect(body.origin).toBe(origin);
            expect(body.code).toBe("ABC234");
            expect(init!.headers).toEqual({ "content-type": "application/json" });
            expect(body).not.toHaveProperty("challenge");
            return Response.json(
              { id: "a".repeat(64), receipt: "r".repeat(43), expiresAt: ticketExpiry },
              { status: 202 },
            );
          }
          if (String(input) === `${issuer}/api/server-pairings/grant`) {
            const body = JSON.parse(init!.body as string);
            if (!body.challenge || !approved)
              return Response.json(
                { status: approved ? "approved" : "pending", expiresAt: ticketExpiry },
                { status: 202 },
              );
            const grant = await sign(body.challenge);
            return Response.json({
              id: "a".repeat(64),
              receipt: "r".repeat(43),
              grant,
              expiresAt: decodeJwt(grant).exp,
            });
          }
          if (String(input) === `${issuer}/api/server-pairings/report`) {
            const body = JSON.parse(init!.body as string);
            reports.push(body.success);
            if (body.success) expect(await prisma!.spaceMember.count()).toBe(1);
            return Response.json({ ok: true });
          }
          throw new Error("Unexpected offline request");
        }),
      );
      const auth = createAuth(prisma!, {
        secret: "offline-paired-server-session-secret-at-least-32-characters",
        baseURL: origin,
        webOrigin: origin,
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "blocked.example.test",
        singleAccount: true,
        nativeAccounts: { issuer },
      });
      const request = (path: string, body: object) =>
        auth.handler(
          new Request(`${origin}/api/auth/native/${path}`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      let lastPairingId = "";
      const pair = async () => {
        const submitted = await request("pair", { code: "ABC234" });
        if (submitted.status !== 202) return submitted;
        const body = (await submitted.json()) as { pairingId: string };
        lastPairingId = body.pairingId;
        return request("pair/status", body);
      };
      try {
        expect((await pair()).status).toBe(202);
        expect(
          await prisma!.verification.count({
            where: { identifier: { startsWith: "native-login-challenge:" } },
          }),
        ).toBe(0);
        expect(await prisma!.user.count()).toBe(0);
        expect(await prisma!.session.count()).toBe(0);
        approved = true;
        // A signed ordinary login proof cannot grant initialization rights through either endpoint.
        expect((await pair()).status).toBe(403);
        const initial = await request("challenge", {});
        const { challenge } = (await initial.json()) as { challenge: string };
        expect(
          (await request("complete", { challenge, grant: await sign(challenge) })).status,
        ).toBe(403);
        expect(await prisma!.user.count()).toBe(0);
        expect(
          (await prisma!.deploymentSettings.findUnique({ where: { id: "default" } }))
            ?.nativeAccountsOwnerKey,
        ).toBeNull();
        purpose = SERVER_PAIRING_PURPOSE;
        jwtId = randomUUID();
        const paired = await pair();
        expect(paired.status, await paired.clone().text()).toBe(200);
        expect(await paired.json()).toEqual({ paired: true });
        expect(paired.headers.getSetCookie()).toEqual([]);
        const reportCount = reports.length;
        const recovered = await request("pair/status", { pairingId: lastPairingId });
        expect(recovered.status).toBe(200);
        expect(await recovered.json()).toEqual({ paired: true });
        expect(reports).toHaveLength(reportCount);
        expect(await prisma!.session.count()).toBe(0);
        expect(await prisma!.user.count()).toBe(1);
        expect(await prisma!.account.count()).toBe(1);
        expect(await prisma!.spaceMember.count()).toBe(1);
        const ownerKey = oidcAccountSubject(issuer, subject);
        expect(
          (await prisma!.deploymentSettings.findUnique({ where: { id: "default" } }))
            ?.nativeAccountsOwnerKey,
        ).toBe(ownerKey);
        // Once admitted, even the current owner cannot start another browser initialization.
        expect((await pair()).status).toBe(403);
        subject = "foreign-owner";
        jwtId = randomUUID();
        expect((await pair()).status).toBe(403);
        expect(await prisma!.user.count()).toBe(1);
        expect(await prisma!.account.count()).toBe(1);
        expect(await prisma!.session.count()).toBe(0);
        expect(
          (await prisma!.deploymentSettings.findUnique({ where: { id: "default" } }))
            ?.nativeAccountsOwnerKey,
        ).toBe(ownerKey);
        subject = "paired-owner";
        jwtId = randomUUID();
        const again = await pair();
        expect(again.status, await again.clone().text()).toBe(403);
        expect(await prisma!.session.count()).toBe(0);
        const next = await request("challenge", {});
        const fresh = (await next.json()) as { challenge: string; bootstrapRequired: boolean };
        expect(fresh.bootstrapRequired).toBe(false);
        jwtId = randomUUID();
        const native = await request("complete", {
          challenge: fresh.challenge,
          grant: await sign(fresh.challenge, "orkbot-server-login-v1"),
        });
        expect(native.status, await native.clone().text()).toBe(200);
        expect(native.headers.get("set-cookie")).toContain("session_token=");
        expect(await prisma!.session.count()).toBe(1);
        expect(reports).toEqual([false, true]);
      } finally {
        auth.disposeOidcDiscovery();
        vi.unstubAllGlobals();
      }
    }));

  it("signs an unattended owner in and out with cookie and bearer sessions through production hooks", async () =>
    system(async () => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = {
        ...publicKey.export({ format: "jwk" }),
        kid: "native-pg",
        alg: "RS256",
        use: "sig",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          if (String(input) !== `${issuer}/api/auth/jwks`)
            throw new Error("Unexpected offline request");
          return Response.json({ keys: [jwk] });
        }),
      );
      const auth = createAuth(prisma!, {
        secret: "offline-native-server-session-secret-with-32-characters",
        baseURL: origin,
        webOrigin: origin,
        passwordAuth: false,
        signupsEnabled: "false",
        signupAllowlist: "",
        nativeAccounts: { issuer, bootstrapSecret: secret },
      });
      const request = (path: string, body: object, headers: Record<string, string> = {}) =>
        auth.handler(
          new Request(`${origin}/api/auth/native/${path}`, {
            method: "POST",
            headers: { origin, "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          }),
        );
      const login = async (subject: string, bootstrapSecret?: string) => {
        const challengeResponse = await request("challenge", {});
        expect(challengeResponse.status, await challengeResponse.clone().text()).toBe(200);
        const { challenge, bootstrapRequired } = (await challengeResponse.json()) as {
          challenge: string;
          bootstrapRequired: boolean;
        };
        const now = Math.floor(Date.now() / 1000);
        const grant = await new SignJWT({
          iss: issuer,
          aud: origin,
          sub: subject,
          nonce: challenge,
          jti: randomUUID(),
          purpose: "orkbot-server-login-v1",
          iat: now,
          exp: now + 60,
          email: `${subject}@example.test`,
          email_verified: true,
          name: "Native Owner",
        })
          .setProtectedHeader({ alg: "RS256", kid: "native-pg" })
          .sign(privateKey);
        return {
          bootstrapRequired,
          challenge,
          grant,
          response: await request("complete", {
            challenge,
            grant,
            ...(bootstrapSecret ? { bootstrapSecret } : {}),
          }),
        };
      };
      try {
        const refused = await login("owner-a", "incorrect");
        expect(refused.response.status).toBe(403);
        expect(await prisma!.user.count()).toBe(0);
        const first = await login("owner-a", secret);
        expect(first.bootstrapRequired).toBe(true);
        expect(first.response.status, await first.response.clone().text()).toBe(200);
        const signedIn = (await first.response.json()) as { token: string; user: { id: string } };
        expect(signedIn.token).toContain(".");
        const cookie = first.response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const byCookie = await auth.handler(
          new Request(`${origin}/api/auth/get-session`, { headers: { cookie, origin } }),
        );
        expect(((await byCookie.json()) as { user: { id: string } }).user.id).toBe(
          signedIn.user.id,
        );
        const byBearer = await auth.handler(
          new Request(`${origin}/api/auth/get-session`, {
            headers: { authorization: `Bearer ${signedIn.token}`, origin },
          }),
        );
        expect(((await byBearer.json()) as { user: { id: string } }).user.id).toBe(
          signedIn.user.id,
        );
        expect(await prisma!.spaceMember.count({ where: { userId: signedIn.user.id } })).toBe(1);
        const second = await login("owner-a");
        expect(second.bootstrapRequired).toBe(false);
        expect(second.response.status, await second.response.clone().text()).toBe(200);
        const secondSession = (await second.response.json()) as { token: string };
        const sessionWith = async (headers: Record<string, string>) => {
          const response = await auth.handler(
            new Request(`${origin}/api/auth/get-session`, { headers: { origin, ...headers } }),
          );
          expect(response.status, await response.clone().text()).toBe(200);
          return response.json();
        };
        const signOut = (headers: Record<string, string>) =>
          auth.handler(
            new Request(`${origin}/api/auth/sign-out`, {
              method: "POST",
              headers: { origin, "content-type": "application/json", ...headers },
              body: "{}",
            }),
          );
        const signedOut = await signOut({ cookie });
        expect(signedOut.status, await signedOut.clone().text()).toBe(200);
        expect(await signedOut.json()).toMatchObject({ success: true });
        expect(
          signedOut.headers
            .getSetCookie()
            .some((value) => value.includes("session_token=;") && value.includes("Max-Age=0")),
        ).toBe(true);
        expect(await sessionWith({ cookie })).toBeNull();
        expect(await sessionWith({ authorization: `Bearer ${signedIn.token}` })).toBeNull();
        expect(
          await prisma!.session.findUnique({ where: { token: signedIn.token.split(".")[0]! } }),
        ).toBeNull();
        expect(await sessionWith({ authorization: `Bearer ${secondSession.token}` })).toMatchObject(
          {
            user: { id: signedIn.user.id },
          },
        );
        const replayed = await request("complete", {
          challenge: first.challenge,
          grant: first.grant,
          bootstrapSecret: secret,
        });
        expect(replayed.status).toBe(403);
        expect(await prisma!.session.count()).toBe(1);
        const signedOutByBearer = await signOut({ authorization: `Bearer ${secondSession.token}` });
        expect(signedOutByBearer.status, await signedOutByBearer.clone().text()).toBe(200);
        expect(await sessionWith({ authorization: `Bearer ${secondSession.token}` })).toBeNull();
        expect(await prisma!.session.count()).toBe(0);
        const renewed = await login("owner-a");
        expect(renewed.challenge).not.toBe(first.challenge);
        expect(renewed.challenge).not.toBe(second.challenge);
        expect(renewed.bootstrapRequired).toBe(false);
        expect(renewed.response.status, await renewed.response.clone().text()).toBe(200);
        const renewedSession = (await renewed.response.json()) as { token: string };
        expect(renewedSession.token).not.toBe(signedIn.token);
        expect(renewedSession.token).not.toBe(secondSession.token);
        expect(
          await sessionWith({ authorization: `Bearer ${renewedSession.token}` }),
        ).toMatchObject({
          user: { id: signedIn.user.id },
        });
        expect(await sessionWith({ cookie })).toBeNull();
        expect(await prisma!.spaceMember.count({ where: { userId: signedIn.user.id } })).toBe(1);
        const stranger = await login("owner-b", secret);
        expect(stranger.response.status).toBe(403);
        expect(await prisma!.user.count()).toBe(1);
        expect(await prisma!.account.count()).toBe(1);
      } finally {
        auth.disposeOidcDiscovery();
        vi.unstubAllGlobals();
      }
    }));
});
