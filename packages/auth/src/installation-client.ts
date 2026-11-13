// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import type { PersonalDeviceTarget } from "@orkbot/contracts";
import {
  IDENTITY_ACCESS_PURPOSE,
  IDENTITY_ACCESS_SECONDS,
  IDENTITY_ENROLLMENT_PURPOSE,
  IDENTITY_LOGIN_PURPOSE,
  IDENTITY_LOGIN_SECONDS,
  IDENTITY_PROJECTION_PURPOSE,
  identityAudience,
  installationRequestMessage,
  installationRoutesInputSchema,
  personalServerMessage,
} from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";
import type { InstallationIdentity, PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { createInstallationTlsIdentity } from "./installation-tls.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const failure = (code: string) => new Error(code);
export class InstallationRequestError extends Error {
  constructor(readonly status: number) {
    super(`Installation request failed (${status})`);
  }
}

export interface InstallationConfiguration {
  serverId: string;
  organizationId: string;
  keyFingerprint: string;
  bindingVersion: number;
}

type AuthorityPurpose =
  | typeof IDENTITY_ENROLLMENT_PURPOSE
  | typeof IDENTITY_LOGIN_PURPOSE
  | typeof IDENTITY_ACCESS_PURPOSE
  | typeof IDENTITY_PROJECTION_PURPOSE;

type InstallationPath =
  | "/servers/synchronize"
  | "/servers/routes"
  | "/workspaces/acknowledge"
  | "/enrollments/acknowledge";

/** One durable installation key is shared by enrollment, request proofs and native transport. */
export class InstallationClient {
  private readonly encryptionKey: string;
  private readonly request: typeof fetch;
  private readonly keys: JWTVerifyGetKey;
  private tlsIdentity?: {
    fingerprint: string;
    expiresAt: number;
    result: ReturnType<typeof createInstallationTlsIdentity>;
  };
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: {
      issuer: string;
      encryptionKey: string;
      request?: typeof fetch;
      keys?: JWTVerifyGetKey;
    },
  ) {
    const issuer = new URL(options.issuer);
    if (
      issuer.protocol !== "https:" ||
      issuer.origin !== options.issuer ||
      issuer.username ||
      issuer.password ||
      options.encryptionKey.length < 32
    )
      throw failure("Invalid installation configuration");
    this.encryptionKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(options.encryptionKey),
        Buffer.alloc(0),
        Buffer.from("ork-installation-private-key-v2"),
        32,
      ),
    ).toString("hex");
    this.request = options.request ?? fetch;
    this.keys =
      options.keys ??
      createRemoteJWKSet(new URL("/api/auth/jwks", options.issuer), {
        cacheMaxAge: 300_000,
        cooldownDuration: 30_000,
        timeoutDuration: 8_000,
        [customFetch]: async (url, init) => {
          const response = await this.request(url, {
            ...init,
            credentials: "omit",
            redirect: "error",
          });
          if (!response.ok) return response;
          return Response.json(await readBoundedJsonResponse(response, 64 * 1024));
        },
      });
  }

  private read() {
    return runAsSystem("read installation identity", () =>
      this.prisma.installationIdentity.findUnique({ where: { id: "local" } }),
    );
  }
  private async load(): Promise<InstallationIdentity> {
    const row = await this.read();
    if (!row || row.issuer !== this.options.issuer)
      throw failure("Installation identity is unavailable");
    return row;
  }
  private async privateKey(row: InstallationIdentity) {
    try {
      const envelope = JSON.parse(
        await symmetricDecrypt({ key: this.encryptionKey, data: row.privateKeyCipher }),
      );
      if (
        envelope.purpose !== "ork-installation-key-v2" ||
        envelope.issuer !== this.options.issuer ||
        envelope.publicKey !== row.publicKey ||
        typeof envelope.privateKey !== "string"
      )
        throw failure("Invalid installation key envelope");
      const key = createPrivateKey({
        key: Buffer.from(envelope.privateKey, "base64url"),
        format: "der",
        type: "pkcs8",
      });
      const derived = createPublicKey(key).export({ type: "spki", format: "der" });
      if (derived.toString("base64url") !== row.publicKey || sha256(derived) !== row.keyFingerprint)
        throw failure("Installation key mismatch");
      return key;
    } catch {
      throw failure("Installation key could not be opened");
    }
  }
  private async sealReceipt(receipt: string, row: InstallationIdentity) {
    return symmetricEncrypt({
      key: this.encryptionKey,
      data: JSON.stringify({
        purpose: "ork-installation-receipt-v2",
        issuer: row.issuer,
        operationId: row.operationId,
        publicKey: row.publicKey,
        receipt,
      }),
    });
  }
  private async receipt(row: InstallationIdentity) {
    try {
      if (!row.receiptCipher) throw failure("Missing receipt");
      const data = JSON.parse(
        await symmetricDecrypt({ key: this.encryptionKey, data: row.receiptCipher }),
      );
      if (
        data.purpose !== "ork-installation-receipt-v2" ||
        data.issuer !== row.issuer ||
        data.operationId !== row.operationId ||
        data.publicKey !== row.publicKey ||
        typeof data.receipt !== "string" ||
        !NONCE.test(data.receipt)
      )
        throw failure("Invalid receipt envelope");
      return data.receipt as string;
    } catch {
      throw failure("Installation enrollment could not be resumed");
    }
  }
  private async post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    rawBody = JSON.stringify(body),
  ) {
    const response = await this.request(`${this.options.issuer}/api/identity/v2${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: rawBody,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new InstallationRequestError(response.status);
    }
    return readBoundedJsonResponse<Record<string, unknown>>(response, 4 * 1024 * 1024);
  }

  async ensureIdentity(): Promise<void> {
    const current = await this.read();
    if (current) {
      await this.privateKey(await this.load());
      return;
    }
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const der = keys.publicKey.export({ type: "spki", format: "der" });
    const publicKey = der.toString("base64url");
    const privateKeyCipher = await symmetricEncrypt({
      key: this.encryptionKey,
      data: JSON.stringify({
        purpose: "ork-installation-key-v2",
        issuer: this.options.issuer,
        publicKey,
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
      }),
    });
    await runAsSystem("initialize durable installation identity", () =>
      this.prisma.installationIdentity.createMany({
        data: {
          id: "local",
          issuer: this.options.issuer,
          publicKey,
          privateKeyCipher,
          keyFingerprint: sha256(der),
          operationId: randomUUID(),
          challenge: randomBytes(32).toString("base64url"),
        },
        skipDuplicates: true,
      }),
    );
    await this.privateKey(await this.load());
  }

  async registered(): Promise<boolean> {
    const row = await this.read();
    return !!row?.serverId;
  }

  async configuration(): Promise<InstallationConfiguration | null> {
    const row = await this.read();
    if (
      !row ||
      row.issuer !== this.options.issuer ||
      row.state !== "ready" ||
      !row.serverId ||
      !row.centralOrganizationId
    )
      return null;
    return {
      serverId: row.serverId,
      organizationId: row.centralOrganizationId,
      keyFingerprint: row.keyFingerprint,
      bindingVersion: row.bindingVersion,
    };
  }

  async transportIdentity() {
    const row = await this.load();
    if (row.state !== "ready" || !row.serverId || !row.centralOrganizationId)
      throw failure("Installation transport is unavailable");
    if (
      !this.tlsIdentity ||
      this.tlsIdentity.fingerprint !== row.keyFingerprint ||
      this.tlsIdentity.expiresAt <= Date.now()
    ) {
      this.tlsIdentity = {
        fingerprint: row.keyFingerprint,
        expiresAt: Date.now() + 3_600_000,
        result: this.privateKey(row).then((key) =>
          createInstallationTlsIdentity(key, row.keyFingerprint),
        ),
      };
    }
    const cached = this.tlsIdentity;
    try {
      return {
        serverId: row.serverId,
        bindingVersion: row.bindingVersion,
        keyFingerprint: row.keyFingerprint,
        ...(await cached.result),
      };
    } catch (error) {
      if (this.tlsIdentity === cached) this.tlsIdentity = undefined;
      throw error;
    }
  }

  /** Resume the same installation after a lost approval or acknowledgement response. */
  async resumeEnrollment(name: string, organizationId: string) {
    await this.ensureIdentity();
    const row = await this.load();
    if (
      !UUID.test(organizationId) ||
      (row.requestedOrganizationId && row.requestedOrganizationId !== organizationId) ||
      (row.centralOrganizationId && row.centralOrganizationId !== organizationId)
    )
      throw failure("Installation organization selection changed");
    if (["ready", "binding", "enrolling"].includes(row.state)) {
      const configuration = await this.pollEnrollment();
      if (configuration) return { state: "ready" as const, ...configuration };
    }
    return {
      state: "approval-required" as const,
      ...(await this.beginEnrollment(name, organizationId)),
    };
  }

  async beginEnrollment(name: string, expectedOrganizationId?: string) {
    await this.ensureIdentity();
    let row = await this.load();
    if (
      !["unregistered", "enrolling"].includes(row.state) ||
      (expectedOrganizationId && !UUID.test(expectedOrganizationId)) ||
      name.trim() !== name ||
      !name ||
      name.length > 100
    )
      throw failure("Installation enrollment cannot start");
    if (
      row.requestedOrganizationId &&
      expectedOrganizationId &&
      row.requestedOrganizationId !== expectedOrganizationId
    )
      throw failure("Installation organization selection changed");
    if (expectedOrganizationId && !row.requestedOrganizationId) {
      await runAsSystem("pin installation enrollment organization", () =>
        this.prisma.installationIdentity.updateMany({
          where: {
            id: "local",
            requestedOrganizationId: null,
            state: { in: ["unregistered", "enrolling"] },
          },
          data: { requestedOrganizationId: expectedOrganizationId },
        }),
      );
      row = await this.load();
      if (row.requestedOrganizationId !== expectedOrganizationId)
        throw failure("Installation organization selection changed");
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(32).toString("base64url");
    const signature = sign(
      "sha256",
      Buffer.from(
        JSON.stringify([
          "ork-server-enrollment-request-v2",
          row.operationId,
          name,
          row.publicKey,
          row.challenge,
          timestamp,
          nonce,
        ]),
      ),
      await this.privateKey(row),
    ).toString("base64url");
    const ticket = await this.post("/enrollments/start", {
      operationId: row.operationId,
      name,
      publicKey: row.publicKey,
      challenge: row.challenge,
      timestamp,
      nonce,
      signature,
    });
    if (
      ticket.version !== 2 ||
      typeof ticket.id !== "string" ||
      !UUID.test(ticket.id) ||
      typeof ticket.code !== "string" ||
      !/^[A-HJ-NP-Z2-9]{10}$/.test(ticket.code) ||
      typeof ticket.receipt !== "string" ||
      !NONCE.test(ticket.receipt) ||
      ticket.keyFingerprint !== row.keyFingerprint ||
      typeof ticket.expiresAt !== "number" ||
      ticket.expiresAt <= timestamp ||
      ticket.expiresAt > timestamp + 905
    )
      throw failure("Invalid installation enrollment response");
    const receiptCipher = await this.sealReceipt(ticket.receipt, row);
    const updated = await runAsSystem("save resumable installation enrollment", () =>
      this.prisma.installationIdentity.updateMany({
        where: {
          id: "local",
          operationId: row.operationId,
          publicKey: row.publicKey,
          state: { in: ["unregistered", "enrolling"] },
        },
        data: { enrollmentId: ticket.id as string, receiptCipher, state: "enrolling" },
      }),
    );
    if (updated.count !== 1) throw failure("Installation enrollment changed");
    return {
      enrollmentId: ticket.id,
      code: ticket.code,
      expiresAt: ticket.expiresAt,
      keyFingerprint: row.keyFingerprint,
    };
  }

  async verify(
    grant: unknown,
    purpose: AuthorityPurpose,
    configuration?: InstallationConfiguration,
  ): Promise<JWTPayload> {
    if (
      ![
        IDENTITY_ENROLLMENT_PURPOSE,
        IDENTITY_LOGIN_PURPOSE,
        IDENTITY_ACCESS_PURPOSE,
        IDENTITY_PROJECTION_PURPOSE,
      ].includes(purpose)
    )
      throw failure("Invalid installation authority purpose");
    if (typeof grant !== "string" || grant.length > 4 * 1024 * 1024)
      throw failure("Invalid installation authority proof");
    if (!configuration && purpose !== IDENTITY_ENROLLMENT_PURPOSE)
      throw failure("Installation audience is required");
    const { payload } = await jwtVerify(grant, this.keys, {
      issuer: this.options.issuer,
      ...(configuration ? { audience: identityAudience(configuration.serverId) } : {}),
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "sub", "purpose", "iat", "exp", "jti"],
    });
    const lifetime = [IDENTITY_ENROLLMENT_PURPOSE, IDENTITY_LOGIN_PURPOSE].includes(purpose)
      ? IDENTITY_LOGIN_SECONDS
      : IDENTITY_ACCESS_SECONDS;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.purpose !== purpose ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat! > now + 5 ||
      payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > lifetime ||
      typeof payload.jti !== "string" ||
      !UUID.test(payload.jti)
    )
      throw failure("Invalid installation authority claims");
    if (
      !configuration &&
      (typeof payload.aud !== "string" || !/^urn:ork:server:[a-f0-9-]{36}$/.test(payload.aud))
    )
      throw failure("Invalid enrollment audience");
    return payload;
  }

  async provePersonalDeviceChallenge(target: PersonalDeviceTarget, challenge: string) {
    const row = await this.load();
    if (
      row.state !== "ready" ||
      !NONCE.test(challenge) ||
      row.serverId !== target.serverId ||
      row.bindingVersion !== target.bindingVersion ||
      row.keyFingerprint !== target.keyFingerprint ||
      !UUID.test(target.deviceId) ||
      !UUID.test(target.workspaceId)
    )
      throw failure("Invalid personal device challenge");
    return {
      publicKey: row.publicKey,
      signature: sign(
        "sha256",
        Buffer.from(personalServerMessage(target, challenge)),
        await this.privateKey(row),
      ).toString("base64url"),
    };
  }

  async publishRoutes(routes: unknown, expected?: InstallationConfiguration): Promise<void> {
    const value = installationRoutesInputSchema.parse(routes);
    const { response } = await this.signedRequest("/servers/routes", { routes: value }, expected);
    if (response.ok !== true) throw failure("Installation routes were not published");
  }

  async signedRequest(path: InstallationPath, body: unknown, expected?: InstallationConfiguration) {
    const row = await this.load();
    if (!row.serverId || !["ready", "binding"].includes(row.state))
      throw failure("Installation is not bound");
    if (
      expected &&
      (row.serverId !== expected.serverId ||
        row.centralOrganizationId !== expected.organizationId ||
        row.bindingVersion !== expected.bindingVersion ||
        row.keyFingerprint !== expected.keyFingerprint)
    )
      throw failure("Installation binding changed");
    const proof = {
      serverId: row.serverId,
      bindingVersion: row.bindingVersion,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: randomBytes(32).toString("base64url"),
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(
      "sha256",
      Buffer.from(
        installationRequestMessage(proof, "POST", `/api/identity/v2${path}`, sha256(rawBody)),
      ),
      await this.privateKey(row),
    ).toString("base64url");
    const startedAt = performance.now();
    const response = await this.post(
      path,
      body,
      {
        "x-ork-server-id": row.serverId,
        "x-ork-binding-version": String(row.bindingVersion),
        "x-ork-proof-time": String(proof.timestamp),
        "x-ork-proof-nonce": proof.nonce,
        "x-ork-proof-signature": signature,
      },
      rawBody,
    );
    return { response, nonce: proof.nonce, startedAt };
  }

  async pollEnrollment() {
    let row = await this.load();
    if (row.state === "ready") return this.configuration();
    if (row.state === "enrolling") {
      if (!row.enrollmentId) throw failure("Installation enrollment is missing");
      const response = await this.post("/enrollments/poll", {
        enrollmentId: row.enrollmentId,
        receipt: await this.receipt(row),
      });
      if (response.state === "pending") return null;
      if (response.state !== "approved") throw failure("Installation enrollment requires recovery");
      const grant = await this.verify(response.grant, IDENTITY_ENROLLMENT_PURPOSE);
      if (
        grant.enrollment_id !== row.enrollmentId ||
        grant.nonce !== row.challenge ||
        grant.installation_key !== row.keyFingerprint ||
        typeof grant.server_id !== "string" ||
        !UUID.test(grant.server_id) ||
        typeof grant.organization_id !== "string" ||
        !UUID.test(grant.organization_id) ||
        grant.aud !== identityAudience(grant.server_id) ||
        grant.sub !== grant.server_id ||
        !Number.isSafeInteger(grant.binding_version) ||
        Number(grant.binding_version) < 1 ||
        (row.requestedOrganizationId && grant.organization_id !== row.requestedOrganizationId)
      )
        throw failure("Installation enrollment proof does not match");
      const saved = await runAsSystem("persist installation binding before acknowledgement", () =>
        this.prisma.installationIdentity.updateMany({
          where: {
            id: "local",
            state: "enrolling",
            operationId: row.operationId,
            enrollmentId: row.enrollmentId,
          },
          data: {
            serverId: grant.server_id as string,
            centralOrganizationId: grant.organization_id as string,
            bindingVersion: Number(grant.binding_version),
            enrollmentGrantId: grant.jti,
            state: "binding",
          },
        }),
      );
      if (saved.count !== 1) throw failure("Installation binding changed");
      row = await this.load();
    }
    if (row.state !== "binding" || !row.enrollmentId || !row.enrollmentGrantId || !row.serverId)
      throw failure("Installation enrollment cannot be acknowledged");
    const { response } = await this.signedRequest("/enrollments/acknowledge", {
      enrollmentId: row.enrollmentId,
      grantId: row.enrollmentGrantId,
    });
    if (response.state !== "ready" || response.serverId !== row.serverId)
      throw failure("Installation readiness was not confirmed");
    await runAsSystem("confirm both sides of installation enrollment", () =>
      this.prisma.installationIdentity.updateMany({
        where: {
          id: "local",
          state: "binding",
          serverId: row.serverId,
          bindingVersion: row.bindingVersion,
          enrollmentId: row.enrollmentId,
        },
        data: { state: "ready" },
      }),
    );
    return this.configuration();
  }
}
