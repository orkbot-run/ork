// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readBoundedJsonResponse } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { oidcAccountSubject } from "./oidc.js";

const KEY = "native-server-claim:active";
const PURPOSE = "orkbot-server-claim-v1";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/;
const LEASE_MS = 30_000;
const REPORT_MS = 24 * 60 * 60 * 1000;

type Claim = {
  state: "pending" | "claimed" | "failed";
  id: string;
  receipt: string;
  proofNonce: string;
  challenge: string;
  expiresAt: number;
  bootstrapMac: string;
  grantId?: string;
  reported?: boolean;
  leaseId?: string;
  leaseUntil?: number;
};
type Issuing = { state: "issuing"; leaseId: string; leaseUntil: number };
type Saved = Claim | Issuing;
type Lease = { value: string; claim: Claim };
type ClaimProof = {
  id: string;
  proofNonce: string;
  status: "pending" | "claimed";
  grantId?: string;
  organizationBinding: true;
};

function parse(value: string): Saved | null {
  try {
    const record = JSON.parse(value) as Saved;
    if (record.state === "issuing")
      return typeof record.leaseId === "string" && typeof record.leaseUntil === "number"
        ? record
        : null;
    if (
      (record.state !== "pending" && record.state !== "claimed" && record.state !== "failed") ||
      !ID.test(record.id) ||
      !TOKEN.test(record.receipt) ||
      !TOKEN.test(record.proofNonce) ||
      !TOKEN.test(record.challenge) ||
      !ID.test(record.bootstrapMac) ||
      !Number.isSafeInteger(record.expiresAt) ||
      (record.state === "claimed" && (!record.grantId || !UUID.test(record.grantId)))
    )
      return null;
    return record;
  } catch {
    return null;
  }
}

function equals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function claimMac(
  claim: Pick<
    Claim,
    "state" | "id" | "receipt" | "proofNonce" | "challenge" | "expiresAt" | "grantId"
  >,
  secret: string,
  origin: string,
): string {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        origin,
        claim.state,
        claim.id,
        claim.receipt,
        claim.proofNonce,
        claim.challenge,
        claim.expiresAt,
        claim.grantId ?? null,
      ]),
    )
    .digest("hex");
}

function validClaimMac(claim: Claim, secret: string | undefined, origin: string): boolean {
  return (
    typeof secret === "string" &&
    secret.length >= 32 &&
    secret.length <= 4096 &&
    equals(claim.bootstrapMac, claimMac(claim, secret, origin))
  );
}

async function ownerAvailable(tx: PrismaClient, lock = false): Promise<boolean> {
  const settings = lock
    ? await tx.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default" },
        update: {},
        select: { nativeAccountsOwnerKey: true, nativeAccountsOrganizationId: true },
      })
    : await tx.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { nativeAccountsOwnerKey: true, nativeAccountsOrganizationId: true },
      });
  if (settings?.nativeAccountsOwnerKey || settings?.nativeAccountsOrganizationId) return false;
  return (
    (await tx.user.count({
      where: {
        NOT: { email: { endsWith: "@messaging.invalid" } },
        members: { some: { spaceMemberships: { some: {} } } },
      },
    })) === 0
  );
}

/** Issue only from a local, operator-controlled process holding the server bootstrap secret. */
export async function issueServerClaim(
  prisma: PrismaClient,
  options: {
    origin: string;
    issuer: string;
    bootstrapSecret: string;
    request?: typeof fetch;
  },
): Promise<{ code: string; expiresAt: number }> {
  if (options.bootstrapSecret.length < 32 || options.bootstrapSecret.length > 4096)
    throw new Error("Server initialization is unavailable.");
  const issuing: Issuing = {
    state: "issuing",
    leaseId: randomBytes(16).toString("hex"),
    leaseUntil: Date.now() + LEASE_MS,
  };
  const reservation = JSON.stringify(issuing);
  await prisma.$transaction(async (tx) => {
    if (!(await ownerAvailable(tx as PrismaClient, true)))
      throw new Error("This server already has an owner.");
    const existing = await tx.verification.findUnique({ where: { id: KEY } });
    if (existing) {
      const saved = parse(existing.value);
      if (
        !saved ||
        (saved.state === "issuing" && saved.leaseUntil > Date.now()) ||
        (saved.state !== "issuing" &&
          (saved.state === "claimed" || (saved.leaseUntil ?? 0) > Date.now()))
      )
        throw new Error("Another server authorization is in progress.");
      const deleted = await tx.verification.deleteMany({
        where: { id: KEY, value: existing.value },
      });
      if (deleted.count !== 1) throw new Error("Another server authorization is in progress.");
    }
    await tx.verification.create({
      data: {
        id: KEY,
        identifier: KEY,
        value: reservation,
        expiresAt: new Date(issuing.leaseUntil),
      },
    });
  });
  try {
    const challenge = randomBytes(32).toString("base64url");
    const response = await post(
      options.issuer,
      "issue",
      { origin: options.origin, challenge },
      options.request,
    );
    const value = response.body as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    if (
      response.status !== 201 ||
      !value ||
      value.origin !== options.origin ||
      typeof value.id !== "string" ||
      !ID.test(value.id) ||
      typeof value.receipt !== "string" ||
      !TOKEN.test(value.receipt) ||
      typeof value.proofNonce !== "string" ||
      !TOKEN.test(value.proofNonce) ||
      typeof value.code !== "string" ||
      !CODE.test(value.code) ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + 305
    )
      throw new Error("Accounts returned an invalid authorization.");
    const ticket = {
      state: "pending",
      id: value.id,
      receipt: value.receipt,
      proofNonce: value.proofNonce,
      challenge,
      expiresAt: value.expiresAt,
    } as const;
    const claim: Claim = {
      ...ticket,
      bootstrapMac: claimMac(ticket, options.bootstrapSecret, options.origin),
    };
    const published = await prisma.$transaction(async (tx) => {
      if (!(await ownerAvailable(tx as PrismaClient, true))) return false;
      const changed = await tx.verification.updateMany({
        where: { id: KEY, value: reservation, expiresAt: { gt: new Date() } },
        data: { value: JSON.stringify(claim), expiresAt: new Date(claim.expiresAt * 1000) },
      });
      return changed.count === 1;
    });
    if (!published) throw new Error("Server authorization could not be started.");
    return { code: value.code, expiresAt: value.expiresAt };
  } catch (error) {
    await prisma.verification
      .deleteMany({ where: { id: KEY, value: reservation } })
      .catch(() => {});
    throw error;
  }
}

/** The public proof only confirms a locally registered attempt; it cannot issue a claim. */
export async function serverClaimProof(
  prisma: PrismaClient,
  id: unknown,
  proofNonce: unknown,
  options: { origin: string; bootstrapSecret?: string },
): Promise<ClaimProof | null> {
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    typeof proofNonce !== "string" ||
    !TOKEN.test(proofNonce)
  )
    return null;
  const row = await prisma.verification.findUnique({ where: { id: KEY } });
  if (!row || row.expiresAt <= new Date()) return null;
  const saved = parse(row.value);
  if (
    !saved ||
    saved.state === "issuing" ||
    !validClaimMac(saved, options.bootstrapSecret, options.origin) ||
    !equals(saved.id, id) ||
    !equals(saved.proofNonce, proofNonce)
  )
    return null;
  if (saved.state === "failed") return null;
  if (saved.state === "pending") {
    if (saved.expiresAt <= Math.floor(Date.now() / 1000) || !(await ownerAvailable(prisma)))
      return null;
    return { id, proofNonce, status: "pending", organizationBinding: true };
  }
  return { id, proofNonce, status: "claimed", grantId: saved.grantId, organizationBinding: true };
}

async function post(
  issuer: string,
  path: "issue" | "poll" | "report",
  body: object,
  request: typeof fetch = fetch,
) {
  const signal = AbortSignal.timeout(8_000);
  const response = await request(new URL(`/api/server-claims/${path}`, issuer), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    redirect: "error",
    signal,
  });
  const value = await readBoundedJsonResponse<unknown>(response, 24 * 1024, signal);
  if (!response.ok) throw new Error("Accounts server authorization failed.");
  return { status: response.status, body: value };
}

export async function verifyServerClaimGrant(
  grant: string,
  options: { issuer: string; origin: string; challenge: string; keys?: JWTVerifyGetKey },
): Promise<JWTPayload> {
  if (grant.length > 16 * 1024) throw new Error("Invalid authorization.");
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL("/api/auth/jwks", options.issuer), {
      timeoutDuration: 8_000,
      cacheMaxAge: 300_000,
      cooldownDuration: 30_000,
      [customFetch]: async (url, init) => {
        const response = await fetch(url, { ...init, credentials: "omit", redirect: "error" });
        return response.status === 200
          ? Response.json(await readBoundedJsonResponse(response, 64 * 1024))
          : response;
      },
    });
  const { payload } = await jwtVerify(grant, keys, {
    issuer: options.issuer,
    audience: options.origin,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "aud", "sub", "nonce", "jti", "iat", "exp", "purpose"],
    maxTokenAge: "60s",
    clockTolerance: 5,
  });
  if (
    Object.keys(payload).some(
      (key) =>
        !["iss", "aud", "sub", "nonce", "jti", "iat", "exp", "purpose", "organization_id"].includes(
          key,
        ),
    ) ||
    payload.aud !== options.origin ||
    payload.purpose !== PURPOSE ||
    (payload.organization_id !== undefined &&
      (typeof payload.organization_id !== "string" || !UUID.test(payload.organization_id))) ||
    payload.nonce !== options.challenge ||
    typeof payload.sub !== "string" ||
    !payload.sub.trim() ||
    payload.sub.length > 1024 ||
    typeof payload.jti !== "string" ||
    !UUID.test(payload.jti) ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp <= payload.iat ||
    payload.exp > payload.iat + 60
  )
    throw new Error("Invalid authorization.");
  return payload;
}

async function acquire(prisma: PrismaClient): Promise<Lease | null> {
  const row = await prisma.verification.findUnique({ where: { id: KEY } });
  if (!row || row.expiresAt <= new Date()) return null;
  const saved = parse(row.value);
  if (!saved || saved.state === "issuing" || saved.reported || (saved.leaseUntil ?? 0) > Date.now())
    return null;
  if (saved.state === "pending" && saved.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const value = JSON.stringify({
    ...saved,
    leaseId: randomBytes(16).toString("hex"),
    leaseUntil: Date.now() + LEASE_MS,
  });
  const claimed = await prisma.verification.updateMany({
    where: { id: KEY, value: row.value, expiresAt: { gt: new Date() } },
    data: { value },
  });
  return claimed.count === 1 ? { value, claim: saved } : null;
}

/** Process one leased poll/report. Each network wait is outside the database transaction. */
export async function processServerClaim(
  prisma: PrismaClient,
  options: {
    issuer: string;
    origin: string;
    bootstrapSecret: string;
    request?: typeof fetch;
    keys?: JWTVerifyGetKey;
  },
): Promise<boolean> {
  const lease = await acquire(prisma);
  if (!lease) return false;
  const { claim } = lease;
  try {
    if (!validClaimMac(claim, options.bootstrapSecret, options.origin)) return false;
    if (claim.state === "claimed" || claim.state === "failed") {
      const report = await post(
        options.issuer,
        "report",
        { id: claim.id, receipt: claim.receipt, success: claim.state === "claimed" },
        options.request,
      );
      if (
        report.status !== 200 ||
        !report.body ||
        typeof report.body !== "object" ||
        !("ok" in report.body) ||
        report.body.ok !== true
      )
        throw new Error("Report failed.");
      await prisma.verification.updateMany({
        where: { id: KEY, value: lease.value },
        data: { value: JSON.stringify({ ...claim, reported: true }) },
      });
      return true;
    }
    const response = await post(
      options.issuer,
      "poll",
      { id: claim.id, receipt: claim.receipt },
      options.request,
    );
    const body = response.body as Record<string, unknown>;
    if (response.status === 202 && body?.status === "pending" && body.expiresAt === claim.expiresAt)
      return true;
    if (
      response.status !== 200 ||
      !body ||
      body.id !== claim.id ||
      typeof body.grant !== "string" ||
      typeof body.expiresAt !== "number"
    )
      throw new Error("Invalid authorization response.");
    const payload = await verifyServerClaimGrant(body.grant, {
      ...options,
      challenge: claim.challenge,
    });
    if (payload.exp !== body.expiresAt) throw new Error("Invalid authorization expiry.");
    const grantId = payload.jti!;
    const owner = oidcAccountSubject(options.issuer, payload.sub!);
    const boundClaim: Claim = { ...claim, state: "claimed", grantId };
    boundClaim.bootstrapMac = claimMac(boundClaim, options.bootstrapSecret, options.origin);
    await prisma.$transaction(async (tx) => {
      if (!(await ownerAvailable(tx as PrismaClient, true))) {
        const failedClaim: Claim = { ...claim, state: "failed" };
        failedClaim.bootstrapMac = claimMac(failedClaim, options.bootstrapSecret, options.origin);
        const saved = await tx.verification.updateMany({
          where: { id: KEY, value: lease.value, expiresAt: { gt: new Date() } },
          data: { value: JSON.stringify(failedClaim), expiresAt: new Date(Date.now() + REPORT_MS) },
        });
        if (saved.count !== 1) throw new Error("Server authorization expired.");
        return;
      }
      const bound = await tx.deploymentSettings.updateMany({
        where: { id: "default", nativeAccountsOwnerKey: null, nativeAccountsOrganizationId: null },
        data: {
          nativeAccountsOwnerKey: owner,
          nativeAccountsOrganizationId:
            typeof payload.organization_id === "string" ? payload.organization_id : null,
        },
      });
      if (bound.count !== 1) throw new Error("Server owner already exists.");
      const admitted = await tx.user.count({
        where: {
          NOT: { email: { endsWith: "@messaging.invalid" } },
          members: { some: { spaceMemberships: { some: {} } } },
        },
      });
      if (admitted !== 0) throw new Error("Server owner already exists.");
      const saved = await tx.verification.updateMany({
        where: { id: KEY, value: lease.value, expiresAt: { gt: new Date() } },
        data: {
          value: JSON.stringify(boundClaim),
          expiresAt: new Date(Date.now() + REPORT_MS),
        },
      });
      if (saved.count !== 1) throw new Error("Server authorization expired.");
    });
    return true;
  } finally {
    await prisma.verification
      .updateMany({
        where: { id: KEY, value: lease.value },
        data: { value: JSON.stringify(claim) },
      })
      .catch(() => {});
  }
}

/** Every replica may poll; value CAS ensures only one performs a broker call at a time. */
export function startServerClaimWorker(
  prisma: PrismaClient,
  options: { issuer: string; origin: string; bootstrapSecret: string },
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (stopped) return;
    let active = false;
    running = processServerClaim(prisma, options)
      .then((result) => {
        active = result;
      })
      .catch(() => {
        active = true;
      })
      .finally(() => {
        running = undefined;
        if (!stopped) timer = setTimeout(tick, active ? 3_000 : 30_000);
      });
  };
  timer = setTimeout(tick, 0);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
