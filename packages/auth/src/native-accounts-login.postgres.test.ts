// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { bootstrapUserSpace, createDb, runAsSystem } from "@orkbot/db";
import { SignJWT } from "jose";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "./index.js";
import { nativeLoginStore } from "./native-accounts-login.js";
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
        where: { identifier: { startsWith: "native-login-" } },
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
        const c = await store.issue(origin);
        await expect(
          store.consume({
            origin,
            challenge: c.challenge,
            identity: identity("owner-a"),
            bootstrapSecret: secret,
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
