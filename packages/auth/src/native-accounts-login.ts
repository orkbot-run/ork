// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeServerPairingCode, SERVER_PAIRING_PURPOSE } from "@orkbot/contracts";
import { isPersonalOrkId, readBoundedJsonResponse } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { oidcAccountSubject } from "./oidc.js";

const PURPOSE = "orkbot-server-login-v1";
const CHALLENGE_SECONDS = 120;
const CHALLENGE_PREFIX = "native-login-challenge:";
const GRANT_PREFIX = "native-login-grant:";
const MAX_GRANT_BYTES = 16 * 1024;

export interface NativeLoginIdentity {
  issuer: string;
  subject: string;
  allowProvision?: boolean;
}
export interface NativeLoginGrant extends NativeLoginIdentity {
  email: string;
  name: string;
  orkAvatar?: string;
  jwtId: string;
  expiresAt: number;
}
export type NativeGrantVerifier = (grant: string, challenge: string) => Promise<NativeLoginGrant>;
const verifiedLogin = new AsyncLocalStorage<NativeLoginIdentity>();

/** Only a signature-verified login flow can establish this request-local proof. */
export function nativeLoginProof(): NativeLoginIdentity | undefined {
  return verifiedLogin.getStore();
}

const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const challengeId = (challenge: string) => CHALLENGE_PREFIX + digest(challenge);
const denied = () =>
  new APIError("FORBIDDEN", {
    code: "NATIVE_LOGIN_REFUSED",
    message: "Could not continue",
  });

function sameSecret(expected: string | undefined, provided: unknown): boolean {
  if (!expected || expected.length < 32 || typeof provided !== "string" || provided.length > 4096)
    return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Fixed issuer/JWKS and exact audience prevent a server proof from becoming a general account bearer. */
export function createNativeGrantVerifier(options: {
  issuer: string;
  origin: string;
  keys?: JWTVerifyGetKey;
  purpose?: typeof PURPOSE | typeof SERVER_PAIRING_PURPOSE;
}): NativeGrantVerifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL("/api/auth/jwks", options.issuer), {
      timeoutDuration: 8_000,
      cacheMaxAge: 300_000,
      cooldownDuration: 30_000,
      [customFetch]: async (url, init) => {
        const response = await fetch(url, { ...init, credentials: "omit", redirect: "error" });
        if (response.status !== 200) return response;
        return Response.json(await readBoundedJsonResponse(response, 64 * 1024));
      },
    });
  return async (grant, challenge) => {
    if (typeof grant !== "string" || grant.length > MAX_GRANT_BYTES) throw denied();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(grant, keys, {
        issuer: options.issuer,
        audience: options.origin,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "sub", "nonce", "jti", "iat", "exp", "purpose"],
        maxTokenAge: "60s",
        clockTolerance: 5,
      }));
    } catch {
      throw denied();
    }
    if (
      payload.aud !== options.origin ||
      payload.purpose !== (options.purpose ?? PURPOSE) ||
      payload.nonce !== challenge ||
      typeof payload.sub !== "string" ||
      !payload.sub.trim() ||
      payload.sub.length > 1024 ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 16 ||
      payload.jti.length > 128 ||
      /[^A-Za-z0-9_-]/.test(payload.jti) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp > payload.iat + 60 ||
      payload.exp <= payload.iat ||
      payload.email_verified !== true ||
      typeof payload.email !== "string" ||
      !payload.email.includes("@") ||
      payload.email.length > 320 ||
      typeof payload.name !== "string" ||
      payload.name.length > 200
    )
      throw denied();
    return {
      ...(options.purpose === SERVER_PAIRING_PURPOSE ? { allowProvision: true } : {}),
      issuer: options.issuer,
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name,
      ...(isPersonalOrkId(payload.ork_avatar) ? { orkAvatar: payload.ork_avatar } : {}),
      jwtId: payload.jti,
      expiresAt: payload.exp,
    };
  };
}

export interface NativeLoginStore {
  issue(origin: string): Promise<{ challenge: string; expiresAt: number }>;
  bootstrapRequired(): Promise<boolean>;
  consume(input: {
    origin: string;
    challenge: string;
    identity: NativeLoginGrant;
    bootstrapSecret?: string;
  }): Promise<{ allowProvision: boolean }>;
}

/** Database claims make challenge, replay, and first-owner admission safe across API instances. */
export function nativeLoginStore(
  prisma: PrismaClient,
  options: { expectedOwnerKey?: string; bootstrapSecret?: string },
): NativeLoginStore {
  return {
    async issue(origin) {
      const challenge = randomBytes(32).toString("base64url");
      const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS;
      await prisma.verification.deleteMany({
        where: { identifier: { startsWith: "native-login-" }, expiresAt: { lt: new Date() } },
      });
      await prisma.verification.create({
        data: {
          id: challengeId(challenge),
          identifier: challengeId(challenge),
          value: origin,
          expiresAt: new Date(expiresAt * 1000),
        },
      });
      return { challenge, expiresAt };
    },
    async bootstrapRequired() {
      if (options.expectedOwnerKey) return false;
      const settings = await prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { nativeAccountsOwnerKey: true },
      });
      if (settings?.nativeAccountsOwnerKey) return false;
      const existing = await prisma.account.count({
        where: {
          providerId: "oidc",
          user: { members: { some: { spaceMemberships: { some: {} } } } },
        },
      });
      return existing === 0;
    },
    async consume(input) {
      const accountKey = oidcAccountSubject(input.identity.issuer, input.identity.subject);
      if (options.expectedOwnerKey && options.expectedOwnerKey !== accountKey) throw denied();
      try {
        return await prisma.$transaction(async (tx) => {
          let allowProvision = Boolean(options.expectedOwnerKey);
          const account = await tx.account.findFirst({
            where: { providerId: "oidc", accountId: accountKey },
            select: { userId: true },
          });
          if (!account) {
            const admitted = await tx.user.count({
              where: {
                NOT: { email: { endsWith: "@messaging.invalid" } },
                members: { some: { spaceMemberships: { some: {} } } },
              },
            });
            if (admitted > 0) throw denied();
          }
          if ((!account || input.identity.allowProvision === true) && !options.expectedOwnerKey) {
            const settings = await tx.deploymentSettings.upsert({
              where: { id: "default" },
              create: { id: "default" },
              update: {},
              select: { nativeAccountsOwnerKey: true },
            });
            if (input.identity.allowProvision === true) {
              const otherAdmitted = await tx.user.count({
                where: {
                  ...(account ? { id: { not: account.userId } } : {}),
                  NOT: { email: { endsWith: "@messaging.invalid" } },
                  members: { some: { spaceMemberships: { some: {} } } },
                },
              });
              if (otherAdmitted > 0) throw denied();
            }
            if (settings.nativeAccountsOwnerKey && settings.nativeAccountsOwnerKey !== accountKey)
              throw denied();
            allowProvision = true;
            if (!settings.nativeAccountsOwnerKey) {
              if (
                input.identity.allowProvision !== true &&
                !sameSecret(options.bootstrapSecret, input.bootstrapSecret)
              )
                throw denied();
              const claimed = await tx.deploymentSettings.updateMany({
                where: { id: "default", nativeAccountsOwnerKey: null },
                data: { nativeAccountsOwnerKey: accountKey },
              });
              if (claimed.count !== 1) throw denied();
            }
          }
          if (account && !allowProvision) {
            const settings = await tx.deploymentSettings.findUnique({
              where: { id: "default" },
              select: { nativeAccountsOwnerKey: true },
            });
            allowProvision = settings?.nativeAccountsOwnerKey === accountKey;
          }
          const consumed = await tx.verification.deleteMany({
            where: {
              id: challengeId(input.challenge),
              value: input.origin,
              expiresAt: { gt: new Date() },
            },
          });
          if (consumed.count !== 1) throw denied();
          const replayId =
            GRANT_PREFIX + digest(JSON.stringify([input.identity.issuer, input.identity.jwtId]));
          await tx.verification.create({
            data: {
              id: replayId,
              identifier: replayId,
              value: input.origin,
              expiresAt: new Date((input.identity.expiresAt + 5) * 1000),
            },
          });
          return { allowProvision };
        });
      } catch {
        throw denied();
      }
    },
  };
}

export function nativeAccountsLogin(
  prisma: PrismaClient,
  options: {
    origin: string;
    issuer: string;
    bootstrapSecret?: string;
    expectedOwnerKey?: string;
    verifyGrant?: NativeGrantVerifier;
    verifyPairingGrant?: NativeGrantVerifier;
    provisionUser?: (user: { id: string; email: string; emailVerified: boolean }) => Promise<void>;
    store?: NativeLoginStore;
  },
): BetterAuthPlugin {
  const verify = options.verifyGrant ?? createNativeGrantVerifier(options);
  const verifyPairing =
    options.verifyPairingGrant ??
    createNativeGrantVerifier({
      ...options,
      purpose: SERVER_PAIRING_PURPOSE,
    });
  const store = options.store ?? nativeLoginStore(prisma, options);
  const provisionIdentity = async (
    ctx: Parameters<typeof setSessionCookie>[0],
    identity: NativeLoginGrant,
    grant: string,
  ) => {
    const accountKey = oidcAccountSubject(identity.issuer, identity.subject);
    const adapter = ctx.context.internalAdapter;
    const existing = await adapter.findAccountByKey({
      providerId: "oidc",
      accountId: accountKey,
    });
    let user: Awaited<ReturnType<typeof adapter.findUserById>>;
    if (existing) {
      user = await adapter.findUserById(existing.userId);
      if (!user) throw denied();
      const collision = await adapter.findUserByEmail(identity.email);
      if (collision && collision.user.id !== user.id) throw denied();
      user = await adapter.updateUser(user.id, {
        email: identity.email,
        emailVerified: true,
        name: identity.name,
        ...(identity.orkAvatar ? { orkAvatar: identity.orkAvatar } : {}),
      });
      await adapter.updateAccount(existing.id, { idToken: grant });
    } else {
      if (await adapter.findUserByEmail(identity.email)) throw denied();
      user = await adapter.createUser(
        {
          name: identity.name,
          email: identity.email,
          emailVerified: true,
          ...(identity.orkAvatar ? { orkAvatar: identity.orkAvatar } : {}),
        },
        {
          method: "oauth",
          oauth: {
            providerId: "oidc",
            profile: { sub: identity.subject, iss: identity.issuer },
          },
        },
      );
      await adapter.createAccount({
        userId: user.id,
        providerId: "oidc",
        accountId: accountKey,
        idToken: grant,
      });
    }
    if (!user) throw denied();
    return user;
  };
  const brokerPost = async (path: "redeem" | "report", body: object) => {
    const response = await fetch(new URL(`/api/server-pairings/${path}`, options.issuer), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw denied();
    const result = await readBoundedJsonResponse(response, 24 * 1024);
    if (
      path === "report" &&
      (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true)
    )
      throw denied();
    return result;
  };
  return {
    id: "native-accounts-login",
    endpoints: {
      nativeAccountsPair: createAuthEndpoint("/native/pair", { method: "POST" }, async (ctx) => {
        ctx.setHeader("Cache-Control", "no-store");
        // This browser endpoint only accepts the configured server's own page.
        if (ctx.headers?.get("origin") !== options.origin || !options.provisionUser) throw denied();
        const code = normalizeServerPairingCode((ctx.body as { code?: unknown } | undefined)?.code);
        if (!code) throw denied();
        const { challenge } = await store.issue(options.origin);
        let receipt: { id: string; receipt: string } | undefined;
        try {
          const redeemed = await brokerPost("redeem", { code, origin: options.origin, challenge });
          if (
            !redeemed ||
            typeof redeemed !== "object" ||
            !("id" in redeemed) ||
            typeof redeemed.id !== "string" ||
            !/^[a-f0-9]{64}$/.test(redeemed.id) ||
            !("receipt" in redeemed) ||
            typeof redeemed.receipt !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(redeemed.receipt) ||
            !("grant" in redeemed) ||
            typeof redeemed.grant !== "string" ||
            redeemed.grant.length > MAX_GRANT_BYTES ||
            !("expiresAt" in redeemed) ||
            typeof redeemed.expiresAt !== "number" ||
            !Number.isSafeInteger(redeemed.expiresAt) ||
            redeemed.expiresAt <= Math.floor(Date.now() / 1000) ||
            redeemed.expiresAt > Math.floor(Date.now() / 1000) + 60
          )
            throw denied();
          receipt = { id: redeemed.id, receipt: redeemed.receipt };
          const grant = redeemed.grant;
          const identity = await verifyPairing(grant, challenge);
          if (identity.allowProvision !== true || identity.expiresAt !== redeemed.expiresAt)
            throw denied();
          if (
            options.expectedOwnerKey &&
            oidcAccountSubject(identity.issuer, identity.subject) !== options.expectedOwnerKey
          )
            throw denied();
          const authorization = await store.consume({
            origin: options.origin,
            challenge,
            identity,
          });
          await verifiedLogin.run({ ...identity, ...authorization }, async () => {
            const user = await provisionIdentity(ctx, identity, grant);
            await options.provisionUser!(user);
          });
          await brokerPost("report", { ...receipt, success: true });
          return ctx.json({ paired: true });
        } catch {
          if (receipt) {
            await brokerPost("report", { ...receipt, success: false }).catch(() => {});
          }
          throw denied();
        }
      }),
      nativeAccountsChallenge: createAuthEndpoint(
        "/native/challenge",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({
            ...(await store.issue(options.origin)),
            bootstrapRequired: await store.bootstrapRequired(),
          });
        },
      ),
      nativeAccountsComplete: createAuthEndpoint(
        "/native/complete",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const body = ctx.body as
            | { challenge?: unknown; grant?: unknown; bootstrapSecret?: unknown }
            | undefined;
          if (
            !body ||
            typeof body.challenge !== "string" ||
            body.challenge.length !== 43 ||
            !/^[A-Za-z0-9_-]{43}$/.test(body.challenge) ||
            typeof body.grant !== "string" ||
            body.grant.length > MAX_GRANT_BYTES ||
            (body.bootstrapSecret !== undefined &&
              (typeof body.bootstrapSecret !== "string" || body.bootstrapSecret.length > 4096))
          )
            throw denied();
          const grant = body.grant;
          const identity = await verify(grant, body.challenge);
          const accountKey = oidcAccountSubject(identity.issuer, identity.subject);
          if (options.expectedOwnerKey && options.expectedOwnerKey !== accountKey) throw denied();
          const authorization = await store.consume({
            origin: options.origin,
            challenge: body.challenge,
            identity,
            ...(typeof body.bootstrapSecret === "string"
              ? { bootstrapSecret: body.bootstrapSecret }
              : {}),
          });
          return verifiedLogin.run({ ...identity, ...authorization }, async () => {
            const user = await provisionIdentity(ctx, identity, grant);
            const adapter = ctx.context.internalAdapter;
            const session = await adapter.createSession(user.id);
            if (!session) throw denied();
            await setSessionCookie(ctx, { session, user });
            return ctx.json({ token: session.token, user: { id: user.id } });
          });
        },
      ),
    },
  };
}
