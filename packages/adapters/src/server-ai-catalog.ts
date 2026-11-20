// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { RealtimeFanout, SecretStore } from "@orkbot/adapter-kit";
import { AIBudgetSchema, AIModelsSchema } from "@orkbot/contracts";
import type { Prisma, PrismaClient } from "@orkbot/db";
import { runAsSystem, workspaceAdmissionBinding } from "@orkbot/db";
import { z } from "zod";
import { modelSupportsZeroDataRetention } from "./model-connection-metadata.js";
import {
  assertModelEndpointAllowed,
  assertModelProviderAllowed,
  isModelEndpointAllowed,
  isModelProviderAllowed,
  ModelProviderBlockedError,
} from "./model-provider-policy.js";
import { withOAuthRefreshLock } from "./oauth-refresh-lock.js";
import { oauthCredentialAccountId, parseModelSecret, serializeModelSecret } from "./pi-oauth.js";

const modelsSchema = AIModelsSchema;
const microsSchema = AIBudgetSchema;
const accountSettingsSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    models: modelsSchema,
    concurrencyLimit: z.number().int().min(1).max(128),
    monthlyBudgetMicros: microsSchema,
  })
  .strict();
const LEASE_MS = 30_000;
export type AIActor = {
  userId: string;
  spaceId: string;
  sessionId?: string;
  membershipVersion?: string;
};
export type AIWorkPermission = { signal: AbortSignal; dispose(): void };
export class AIConnectionError extends Error {
  constructor(
    readonly code: "forbidden" | "unavailable" | "busy" | "budget" | "conflict" | "invalid",
  ) {
    super(`AI connection ${code}`);
  }
}
export interface AIExecutionClaim {
  operationId: string;
  connectionId: string;
  modelId: string;
  scope: AIActor;
  signal: AbortSignal;
  dispose(): void;
}
const deny = (code: AIConnectionError["code"]): never => {
  throw new AIConnectionError(code);
};
const accountTopic = (id: string) => `ai-account:${id}`;
const workspaceTopic = (id: string) => `ai-workspace:${id}`;

/** Credentials are installation-owned. API callers receive only the explicitly selected metadata. */
export class ServerAICatalog {
  private readonly issued = new WeakSet<AIExecutionClaim>();
  private readonly executions = new Map<
    string,
    {
      claim: AIExecutionClaim;
      controller: AbortController;
      deadline: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      secrets: SecretStore;
      principal(actor: AIActor): Promise<string | null>;
      authorizeWork(actor: AIActor): Promise<AIWorkPermission | null>;
      realtime: RealtimeFanout;
    },
  ) {}

  private async serverAdmin(actor: AIActor) {
    const key = await this.deps.principal(actor);
    if (!key) return deny("forbidden");
    const [workspace, installation] = await Promise.all([
      this.deps.prisma.$transaction((tx) => this.workspace(tx, actor)),
      this.deps.prisma.installationIdentity.findUnique({ where: { id: "local" } }),
    ]);
    if (
      !workspace.organizationAdministrator ||
      !installation ||
      installation.state !== "ready" ||
      !installation.serverId ||
      !installation.projectionGrant ||
      workspace.serverId !== installation.serverId ||
      workspace.centralOrganizationId !== installation.centralOrganizationId ||
      workspace.organizationId !== installation.localOrganizationId ||
      workspace.version !== installation.bindingVersion
    )
      return deny("forbidden");
    return {
      accountKey: key,
      bindingVersion: installation.bindingVersion,
      organizationId: workspace.organizationId,
      serverId: installation.serverId,
    };
  }

  async adminIdentity(actor: AIActor) {
    return runAsSystem("verify the organization AI administrator", async () => {
      const { accountKey, bindingVersion } = await this.serverAdmin(actor);
      return { accountKey, bindingVersion };
    });
  }

  private async workspace(tx: Prisma.TransactionClient, actor: AIActor, administration = false) {
    const binding = await workspaceAdmissionBinding(tx, actor.spaceId);
    if (binding) {
      if (binding.spaceId !== actor.spaceId) {
        const member = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
        if (!member || (administration && !["owner", "admin"].includes(member.role)))
          return deny("forbidden");
      }
      const access = await tx.centralWorkspaceAccess.findUnique({
        where: { workspaceId_userId: { workspaceId: binding.id, userId: actor.userId } },
      });
      if (
        binding.state !== "ready" ||
        !access?.active ||
        !actor.membershipVersion ||
        access.membershipVersion !== actor.membershipVersion ||
        (administration && access.role !== "admin")
      )
        return deny("forbidden");
      if (binding.validUntil.getTime() <= Date.now()) {
        // Requests and execution retain their authority watches; this uses the same durable
        // personal admission as row security without opening another database connection.
        const [personal] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT app_personal_workspace_access(${binding.id}, ${actor.userId}) AS allowed`;
        if (!personal?.allowed) return deny("forbidden");
      }
      return {
        organizationId: binding.localOrganizationId,
        serverId: binding.serverId,
        centralOrganizationId: binding.centralOrganizationId,
        version: binding.bindingVersion,
        administrator: access.role === "admin",
        organizationRoleKnown:
          binding.validUntil.getTime() > Date.now() &&
          Array.isArray(binding.members) &&
          binding.members.some(
            (member) =>
              member &&
              typeof member === "object" &&
              !Array.isArray(member) &&
              member.userId === access.centralSubject &&
              member.accessVersion === access.membershipVersion &&
              typeof member.organizationRole === "string",
          ),
        organizationAdministrator:
          binding.validUntil.getTime() > Date.now() &&
          Array.isArray(binding.members) &&
          binding.members.some(
            (member) =>
              member &&
              typeof member === "object" &&
              !Array.isArray(member) &&
              member.userId === access.centralSubject &&
              member.accessVersion === access.membershipVersion &&
              member.organizationRole === "admin",
          ),
      };
    }
    const member = await tx.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!member || (administration && !["owner", "admin"].includes(member.role)))
      return deny("forbidden");
    return {
      organizationId: member.organizationId,
      serverId: null,
      centralOrganizationId: null,
      version: 0,
      administrator: ["owner", "admin"].includes(member.role),
      organizationRoleKnown: true,
      organizationAdministrator: ["owner", "admin"].includes(member.role),
    };
  }

  private async organizationWorkspaces(
    tx: Prisma.TransactionClient,
    admin: { organizationId: string; serverId: string; bindingVersion: number },
  ) {
    const bindings = await tx.centralWorkspaceBinding.findMany({
      where: {
        localOrganizationId: admin.organizationId,
        serverId: admin.serverId,
        bindingVersion: admin.bindingVersion,
        state: { in: ["ready", "provisioning"] },
        space: { deletingAt: null },
      },
      select: { id: true, spaceId: true, bindingVersion: true },
    });
    const local = await tx.space.findMany({
      where: {
        organizationId: admin.organizationId,
        deletingAt: null,
        centralBinding: null,
        admissionWorkspaceId: { in: bindings.map((binding) => binding.id) },
      },
      select: { id: true },
    });
    return [
      ...bindings.map(({ spaceId, bindingVersion }) => ({ spaceId, bindingVersion })),
      ...local.map(({ id }) => ({ spaceId: id, bindingVersion: admin.bindingVersion })),
    ].sort((a, b) => a.spaceId.localeCompare(b.spaceId));
  }

  private metadata(
    connection: {
      id: string;
      provider: string;
      label: string;
      state: string;
      models: unknown;
      revision: number;
      concurrencyLimit: number;
      monthlyBudgetMicros: bigint | null;
      isDefault?: boolean;
      defaultModelId?: string | null;
    },
    zeroDataRetention?: boolean,
  ) {
    return {
      id: connection.id,
      provider: connection.provider,
      ...(zeroDataRetention !== undefined ? { zeroDataRetention } : {}),
      label: connection.label,
      state: z.enum(["active", "disabled", "reconnect-required"]).parse(connection.state),
      models: modelsSchema.parse(connection.models),
      revision: connection.revision,
      concurrencyLimit: connection.concurrencyLimit,
      ...(connection.isDefault !== undefined
        ? { isDefault: connection.isDefault, defaultModelId: connection.defaultModelId ?? null }
        : {}),
      monthlyBudgetMicros:
        connection.monthlyBudgetMicros === null ? null : Number(connection.monthlyBudgetMicros),
    };
  }

  private async privacySetting(connection: {
    provider: string;
    secretId: string;
    secretRef: string;
  }) {
    if (!modelSupportsZeroDataRetention(connection.provider)) return undefined;
    try {
      const secret = parseModelSecret(
        await this.deps.secrets.load(connection.secretRef, connection.secretId),
      );
      return secret.kind === "api_key" ? secret.zeroDataRetention : undefined;
    } catch {
      return undefined;
    }
  }

  private async blockedByPolicy(connection: {
    provider: string;
    secretId: string;
    secretRef: string;
  }): Promise<boolean> {
    if (!isModelProviderAllowed(connection.provider)) return true;
    if (isModelEndpointAllowed(connection.provider)) return false;
    try {
      const secret = parseModelSecret(
        await this.deps.secrets.load(connection.secretRef, connection.secretId),
      );
      return !isModelEndpointAllowed(
        connection.provider,
        secret.kind === "openai_compatible" ? secret.baseUrl : undefined,
      );
    } catch {
      return true;
    }
  }

  async list(actor: AIActor) {
    return runAsSystem("read assigned AI connection metadata", () =>
      this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor);
        const rows = await tx.workspaceAIConnection.findMany({
          where: {
            spaceId: actor.spaceId,
            available: true,
            bindingVersion: workspace.version,
            ...(workspace.administrator ? {} : { enabled: true }),
          },
          include: { connection: true },
          orderBy: [{ priority: "asc" }, { connectionId: "asc" }],
        });
        const assigned = await Promise.all(
          rows.map(async (row) => {
            const accountModels = modelsSchema.parse(row.connection.models);
            const assignedModels = modelsSchema.parse(row.allowedModels);
            const usableModels = assignedModels.filter((model) => accountModels.includes(model));
            if (!workspace.administrator && !usableModels.length) return [];
            return [
              {
                ...this.metadata({
                  ...row.connection,
                  models: workspace.administrator ? accountModels : usableModels,
                }),
                ...((await this.blockedByPolicy(row.connection)) ? { blockedByPolicy: true } : {}),
                enabled: row.enabled,
                allowedModels: workspace.administrator ? assignedModels : usableModels,
                defaultModelId: row.defaultModelId,
                isDefault: row.isDefault,
                fallback: row.fallback,
                priority: row.priority,
                assignmentRevision: row.revision,
                monthlyBudgetMicros:
                  row.monthlyBudgetMicros === null ? null : Number(row.monthlyBudgetMicros),
              },
            ];
          }),
        );
        return assigned.flat();
      }),
    );
  }

  async accounts(actor: AIActor) {
    return runAsSystem(
      "read server AI catalog as a delegated connection administrator",
      async () => {
        const admin = await this.serverAdmin(actor);
        const rows = await this.deps.prisma.serverAIConnection.findMany({
          where: { localOrganizationId: admin.organizationId },
          orderBy: { createdAt: "asc" },
        });
        return Promise.all(
          rows.map(async (row) => {
            if (await this.blockedByPolicy(row))
              return { ...this.metadata(row), blockedByPolicy: true };
            return this.metadata(row, await this.privacySetting(row));
          }),
        );
      },
    );
  }

  async permissions(actor: AIActor) {
    return runAsSystem("read installation AI management permissions", async () => {
      await this.deps.prisma.$transaction((tx) => this.workspace(tx, actor));
      let canManageServer = false;
      try {
        await this.serverAdmin(actor);
        canManageServer = true;
      } catch (error) {
        if (!(error instanceof AIConnectionError) || error.code !== "forbidden") throw error;
      }
      return { canManageServer, canManageWorkspace: canManageServer };
    });
  }

  async setupMode(actor: AIActor): Promise<"pending" | "organization" | "personal" | "legacy"> {
    return runAsSystem("read organization model setup", () =>
      this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor);
        const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
        if (
          !identity ||
          identity.serverId !== workspace.serverId ||
          identity.centralOrganizationId !== workspace.centralOrganizationId ||
          identity.localOrganizationId !== workspace.organizationId ||
          identity.bindingVersion !== workspace.version
        )
          return deny("forbidden");
        const mode = identity.modelSetupMode;
        if (
          mode !== "pending" &&
          mode !== "organization" &&
          mode !== "personal" &&
          mode !== "legacy"
        )
          return deny("forbidden");
        return mode;
      }),
    );
  }

  async adminAccessReason(
    actor: AIActor,
  ): Promise<"role_unavailable" | "not_admin" | "unverified"> {
    return runAsSystem("diagnose organization model access", () =>
      this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor);
        if (!workspace.organizationRoleKnown) return "role_unavailable";
        return workspace.organizationAdministrator ? "unverified" : "not_admin";
      }),
    );
  }

  async chooseMode(actor: AIActor, mode: "organization" | "personal"): Promise<void> {
    await runAsSystem("choose organization model setup", async () => {
      const admin = await this.serverAdmin(actor);
      await this.deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM installation_identity WHERE id = 'local' FOR UPDATE`;
        const identity = await tx.installationIdentity.findUniqueOrThrow({
          where: { id: "local" },
        });
        if (
          identity.serverId !== admin.serverId ||
          identity.localOrganizationId !== admin.organizationId ||
          identity.bindingVersion !== admin.bindingVersion
        )
          return deny("forbidden");
        await tx.installationIdentity.update({
          where: { id: "local" },
          data: { modelSetupMode: mode },
        });
      });
    });
  }

  /** An enabled connection remains configured even when its provider is unavailable. */
  async hasConfiguredModel(actor: AIActor): Promise<boolean> {
    return runAsSystem("check workspace model policy", () =>
      this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor);
        return Boolean(
          await tx.workspaceAIConnection.findFirst({
            where: {
              space: {
                organizationId: workspace.organizationId,
                centralBinding: {
                  state: { in: ["ready", "provisioning"] },
                  bindingVersion: workspace.version,
                  serverId: workspace.serverId ?? undefined,
                  centralOrganizationId: workspace.centralOrganizationId ?? undefined,
                },
              },
              bindingVersion: workspace.version,
              available: true,
              enabled: true,
            },
            select: { connectionId: true },
          }),
        );
      }),
    );
  }

  async update(
    actor: AIActor,
    connectionId: string,
    input: {
      label: string;
      models: string[];
      concurrencyLimit: number;
      monthlyBudgetMicros: number | null;
      zeroDataRetention?: boolean;
    },
  ) {
    const { zeroDataRetention, ...settings } = input;
    const data = accountSettingsSchema.parse(settings);
    let replacement: Awaited<ReturnType<SecretStore["put"]>> | undefined;
    let retired: { secretId: string; secretRef: string } | undefined;
    const result = await runAsSystem("update installation AI account limits", async () => {
      const admin = await this.serverAdmin(actor);
      return withOAuthRefreshLock(
        this.deps.prisma,
        "server-ai-oauth-v2",
        connectionId,
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${connectionId} FOR UPDATE`;
          let effectivePrivacy: boolean | undefined;
          if (zeroDataRetention !== undefined) {
            const account = await tx.serverAIConnection.findUniqueOrThrow({
              where: { id: connectionId, localOrganizationId: admin.organizationId },
            });
            if (modelSupportsZeroDataRetention(account.provider)) {
              assertModelProviderAllowed(account.provider);
              const current = parseModelSecret(
                await this.deps.secrets.load(account.secretRef, account.secretId),
              );
              if (current.kind !== "api_key") return deny("invalid");
              effectivePrivacy = zeroDataRetention;
              if ((current.zeroDataRetention ?? false) !== zeroDataRetention) {
                replacement = await this.deps.secrets.put(
                  serializeModelSecret({ ...current, zeroDataRetention }),
                  {
                    ...actor,
                    operationId: `ai-zdr:${connectionId}`,
                    traceId: `ai-zdr:${connectionId}`,
                    signal: AbortSignal.timeout(15_000),
                  },
                  { recordId: randomUUID() },
                );
                retired = account;
              }
            } else if (zeroDataRetention) return deny("invalid");
          }
          return this.metadata(
            await tx.serverAIConnection.update({
              where: { id: connectionId, localOrganizationId: admin.organizationId },
              data: {
                ...data,
                monthlyBudgetMicros:
                  data.monthlyBudgetMicros === null ? null : BigInt(data.monthlyBudgetMicros),
                revision: { increment: 1 },
                ...(replacement
                  ? {
                      secretId: replacement.id,
                      secretRef: replacement.ref,
                      credentialVersion: { increment: 1 },
                    }
                  : {}),
              },
            }),
            effectivePrivacy,
          );
        },
      );
    }).catch(async (error) => {
      if (replacement)
        await this.deps.secrets.delete(replacement.ref, replacement.id).catch(() => undefined);
      throw error;
    });
    if (retired)
      await this.deps.secrets.delete(retired.secretRef, retired.secretId).catch(() => undefined);
    await this.notifyAccount(connectionId);
    return result;
  }

  async reconnect(
    actor: AIActor,
    connectionId: string,
    plaintext: string,
    expectedRevision?: number,
    settings?: z.input<typeof accountSettingsSchema>,
  ) {
    const nextSettings = settings ? accountSettingsSchema.parse(settings) : undefined;
    let next: ReturnType<typeof parseModelSecret>;
    try {
      next = parseModelSecret(plaintext);
    } catch {
      return deny("invalid");
    }
    if (next.kind === "oauth" && next.reconnectRequired) return deny("invalid");
    const result = await runAsSystem("reconnect an explicitly delegated AI account", async () => {
      const admin = await this.serverAdmin(actor);
      return withOAuthRefreshLock(
        this.deps.prisma,
        "server-ai-oauth-v2",
        connectionId,
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${connectionId} FOR UPDATE`;
          const account = await tx.serverAIConnection.findUniqueOrThrow({
            where: { id: connectionId, localOrganizationId: admin.organizationId },
          });
          if (expectedRevision !== undefined && account.revision !== expectedRevision)
            return deny("conflict");
          assertModelEndpointAllowed(
            account.provider,
            next.kind === "openai_compatible" ? next.baseUrl : undefined,
          );
          const current = parseModelSecret(
            await this.deps.secrets.load(account.secretRef, account.secretId),
          );
          if (
            next.kind === "api_key" &&
            next.zeroDataRetention === true &&
            !modelSupportsZeroDataRetention(account.provider)
          )
            return deny("invalid");
          const nextSecret =
            next.kind === "api_key" &&
            current.kind === "api_key" &&
            next.zeroDataRetention === undefined &&
            current.zeroDataRetention !== undefined
              ? { ...next, zeroDataRetention: current.zeroDataRetention }
              : next;
          if (
            current.kind === "api_key" &&
            current.zeroDataRetention === true &&
            nextSecret.kind !== "api_key"
          )
            return deny("invalid");
          if ((account.provider === "openai-compatible") !== (next.kind === "openai_compatible"))
            return deny("invalid");
          if (current.kind === "oauth" && !current.reconnectRequired && next.kind === "oauth") {
            const before = oauthCredentialAccountId(current.credential);
            const after = oauthCredentialAccountId(next.credential);
            if (before && after && before !== after) return deny("invalid");
          }
          const stored = await this.deps.secrets.put(
            nextSecret === next ? plaintext : serializeModelSecret(nextSecret),
            {
              ...actor,
              operationId: `ai-reconnect:${connectionId}`,
              traceId: `ai-reconnect:${connectionId}`,
              signal: AbortSignal.timeout(15_000),
            },
            { recordId: randomUUID() },
          );
          return this.metadata(
            await tx.serverAIConnection.update({
              where: { id: connectionId },
              data: {
                ...(nextSettings
                  ? {
                      ...nextSettings,
                      monthlyBudgetMicros:
                        nextSettings.monthlyBudgetMicros === null
                          ? null
                          : BigInt(nextSettings.monthlyBudgetMicros),
                    }
                  : {}),
                state: "active",
                secretId: stored.id,
                secretRef: stored.ref,
                credentialVersion: { increment: 1 },
                revision: { increment: 1 },
              },
            }),
            nextSecret.kind === "api_key" ? nextSecret.zeroDataRetention : undefined,
          );
        },
      );
    });
    await this.notifyAccount(connectionId);
    return result;
  }

  async create(
    actor: AIActor,
    input: {
      label: string;
      provider: string;
      models: string[];
      plaintext: string;
      concurrencyLimit?: number;
      monthlyBudgetMicros?: number | null;
    },
  ) {
    const data = z
      .object({
        label: z.string().trim().min(1).max(100),
        provider: z.string().min(1).max(100),
        models: modelsSchema,
        plaintext: z
          .string()
          .min(1)
          .max(256 * 1024),
        concurrencyLimit: z.number().int().min(1).max(128).default(8),
        monthlyBudgetMicros: microsSchema.default(null),
      })
      .strict()
      .parse(input);
    let secret: ReturnType<typeof parseModelSecret>;
    try {
      secret = parseModelSecret(data.plaintext);
    } catch {
      return deny("invalid");
    }
    assertModelEndpointAllowed(
      data.provider,
      secret.kind === "openai_compatible" ? secret.baseUrl : undefined,
    );
    if (
      secret.kind === "api_key" &&
      secret.zeroDataRetention === true &&
      !modelSupportsZeroDataRetention(data.provider)
    )
      return deny("invalid");
    const id = randomUUID();
    return runAsSystem("create an installation-owned AI account", async () => {
      const admin = await this.serverAdmin(actor);
      const stored = await this.deps.secrets.put(
        data.plaintext,
        {
          ...actor,
          operationId: `ai-account:${id}`,
          traceId: `ai-account:${id}`,
          signal: new AbortController().signal,
        },
        { recordId: id },
      );
      try {
        const row = await this.deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
          const existingDefault = await tx.serverAIConnection.findFirst({
            where: { localOrganizationId: admin.organizationId, isDefault: true },
            select: { id: true },
          });
          const first = !existingDefault;
          const account = await tx.serverAIConnection.create({
            data: {
              id,
              isDefault: first,
              defaultModelId: first ? data.models[0] : null,
              defaultAllowedModels: first ? data.models : undefined,
              localOrganizationId: admin.organizationId,
              label: data.label,
              provider: data.provider,
              models: data.models,
              secretId: stored.id,
              secretRef: stored.ref,
              concurrencyLimit: data.concurrencyLimit,
              monthlyBudgetMicros:
                data.monthlyBudgetMicros === null ? null : BigInt(data.monthlyBudgetMicros),
            },
          });
          const workspaces = await this.organizationWorkspaces(tx, admin);
          for (const workspace of workspaces) {
            const existing = await tx.workspaceAIConnection.findFirst({
              where: {
                spaceId: workspace.spaceId,
                available: true,
                enabled: true,
                isDefault: true,
              },
              select: { connectionId: true },
            });
            await tx.workspaceAIConnection.create({
              data: {
                spaceId: workspace.spaceId,
                connectionId: id,
                bindingVersion: workspace.bindingVersion,
                allowedModels: data.models,
                defaultModelId: data.models[0],
                enabled: first && !existing,
                isDefault: first && !existing,
              },
            });
          }
          if (first)
            await tx.installationIdentity.updateMany({
              where: {
                id: "local",
                modelSetupMode: "pending",
                localOrganizationId: admin.organizationId,
                bindingVersion: admin.bindingVersion,
              },
              data: { modelSetupMode: "organization" },
            });
          return account;
        });
        return this.metadata(row, secret.kind === "api_key" ? secret.zeroDataRetention : undefined);
      } catch (error) {
        await this.deps.secrets.delete(stored.ref, stored.id).catch(() => undefined);
        throw error;
      }
    });
  }

  async offer(
    actor: AIActor,
    spaceId: string,
    connectionId: string,
    available: boolean,
  ): Promise<void> {
    await runAsSystem("make an organization AI account available on this server", async () => {
      const admin = await this.serverAdmin(actor);
      const targets = await this.deps.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${connectionId} FOR UPDATE`;
        const connection = await tx.serverAIConnection.findUnique({ where: { id: connectionId } });
        const space = await tx.space.findUnique({
          where: { id: spaceId },
          select: {
            organizationId: true,
            deletingAt: true,
            centralBinding: { select: { bindingVersion: true } },
          },
        });
        if (
          !connection ||
          !space ||
          space.deletingAt ||
          space.organizationId !== connection.localOrganizationId ||
          space.organizationId !== admin.organizationId
        )
          return deny("forbidden");
        if (available && (await this.blockedByPolicy(connection)))
          throw new ModelProviderBlockedError();
        const workspaces = await this.organizationWorkspaces(tx, admin);
        if (!workspaces.some((workspace) => workspace.spaceId === spaceId))
          return deny("forbidden");
        for (const workspace of workspaces) {
          const current = await tx.workspaceAIConnection.findUnique({
            where: { spaceId_connectionId: { spaceId: workspace.spaceId, connectionId } },
          });
          if (
            current?.available === available &&
            current.bindingVersion === workspace.bindingVersion
          )
            continue;
          await tx.workspaceAIConnection.upsert({
            where: { spaceId_connectionId: { spaceId: workspace.spaceId, connectionId } },
            create: {
              spaceId: workspace.spaceId,
              connectionId,
              available,
              enabled: false,
              allowedModels: modelsSchema.parse(connection.models),
              bindingVersion: workspace.bindingVersion,
            },
            update: {
              available,
              enabled: false,
              bindingVersion: workspace.bindingVersion,
              revision: { increment: 1 },
            },
          });
        }
        return workspaces.map((workspace) => workspace.spaceId);
      });
      for (const target of targets)
        await this.deps.realtime.publish(workspaceTopic(target), JSON.stringify({ connectionId }));
    });
  }

  async configure(
    actor: AIActor,
    connectionId: string,
    input: {
      enabled: boolean;
      allowedModels: string[];
      defaultModelId: string;
      isDefault?: boolean;
      fallback?: boolean;
      priority: number;
      monthlyBudgetMicros: number | null;
      preserveBudget?: boolean;
      expectedRevision?: number;
      preserveDefault?: boolean;
      scope?: "organization" | "space";
    },
  ) {
    const data = z
      .object({
        enabled: z.boolean(),
        allowedModels: modelsSchema,
        defaultModelId: z.string().min(1).max(512),
        isDefault: z.boolean().default(false),
        fallback: z.boolean().default(false),
        priority: z.number().int().min(0).max(1000),
        monthlyBudgetMicros: microsSchema,
        preserveBudget: z.boolean().optional(),
        expectedRevision: z.number().int().positive().optional(),
        preserveDefault: z.boolean().optional(),
        scope: z.enum(["organization", "space"]).optional(),
      })
      .strict()
      .parse(input);
    const targets = await runAsSystem("configure an organization AI account", async () => {
      const admin = await this.serverAdmin(actor);
      return this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor, true);
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
        await tx.aIWorkspacePolicy.createMany({
          data: { spaceId: actor.spaceId },
          skipDuplicates: true,
        });
        await tx.$queryRaw`SELECT "spaceId" FROM ai_workspace_policies WHERE "spaceId" = ${actor.spaceId} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${connectionId} FOR UPDATE`;
        const account = await tx.serverAIConnection.findUnique({ where: { id: connectionId } });
        const assignment = await tx.workspaceAIConnection.findUnique({
          where: { spaceId_connectionId: { spaceId: actor.spaceId, connectionId } },
        });
        if (
          !account ||
          (data.enabled && account.state !== "active") ||
          !assignment?.available ||
          account.localOrganizationId !== workspace.organizationId
        )
          return deny("forbidden");
        if (data.enabled && (await this.blockedByPolicy(account)))
          throw new ModelProviderBlockedError();
        if (data.expectedRevision !== undefined && data.expectedRevision !== assignment.revision)
          return deny("conflict");
        const models = modelsSchema.parse(account.models);
        if (
          !data.allowedModels.includes(data.defaultModelId) ||
          data.allowedModels.some((model) => !models.includes(model))
        )
          return deny("invalid");
        const isDefault = data.preserveDefault ? assignment.isDefault : data.isDefault;
        if (data.enabled && isDefault && data.preserveDefault) {
          const otherDefault = await tx.workspaceAIConnection.findFirst({
            where: {
              spaceId: actor.spaceId,
              bindingVersion: workspace.version,
              available: true,
              enabled: true,
              isDefault: true,
              connectionId: { not: connectionId },
            },
            select: { connectionId: true },
          });
          if (otherDefault) return deny("conflict");
        }
        const workspaces = await this.organizationWorkspaces(tx, admin);
        if (!workspaces.some((item) => item.spaceId === actor.spaceId)) return deny("forbidden");
        if (data.scope === "space") {
          await tx.aIWorkspacePolicy.update({
            where: { spaceId: actor.spaceId },
            data: { overridesModels: true },
          });
        }
        const overrides =
          data.scope === "space"
            ? []
            : await tx.aIWorkspacePolicy.findMany({
                where: {
                  spaceId: { in: workspaces.map((item) => item.spaceId) },
                  overridesModels: true,
                },
                select: { spaceId: true },
              });
        const targets = workspaces.filter((item) =>
          data.scope === "space"
            ? item.spaceId === actor.spaceId
            : !overrides.some((override) => override.spaceId === item.spaceId),
        );
        const workspaceIds = targets.map((item) => item.spaceId);
        if (data.scope !== "space" && !data.preserveDefault && (!data.enabled || !isDefault)) {
          await tx.serverAIConnection.updateMany({
            where: { id: connectionId, isDefault: true },
            data: { isDefault: false },
          });
        }
        if (data.scope !== "space" && data.enabled && isDefault && !data.preserveDefault) {
          await tx.serverAIConnection.updateMany({
            where: {
              localOrganizationId: admin.organizationId,
              isDefault: true,
              id: { not: connectionId },
            },
            data: { isDefault: false },
          });
          await tx.serverAIConnection.update({
            where: { id: connectionId },
            data: {
              isDefault: true,
              defaultModelId: data.defaultModelId,
              defaultAllowedModels: data.allowedModels,
            },
          });
        }
        if (data.enabled && isDefault && !data.preserveDefault)
          await tx.workspaceAIConnection.updateMany({
            where: {
              spaceId: { in: workspaceIds },
              bindingVersion: admin.bindingVersion,
              connectionId: { not: connectionId },
              isDefault: true,
            },
            data: { isDefault: false, revision: { increment: 1 } },
          });
        const {
          preserveBudget,
          preserveDefault: _preserveDefault,
          expectedRevision: _expectedRevision,
          scope: _scope,
          ...configuration
        } = data;
        for (const target of targets)
          await tx.workspaceAIConnection.upsert({
            where: { spaceId_connectionId: { spaceId: target.spaceId, connectionId } },
            create: {
              spaceId: target.spaceId,
              connectionId,
              available: true,
              ...configuration,
              isDefault,
              monthlyBudgetMicros: preserveBudget
                ? assignment.monthlyBudgetMicros
                : data.monthlyBudgetMicros === null
                  ? null
                  : BigInt(data.monthlyBudgetMicros),
              bindingVersion: target.bindingVersion,
            },
            update: {
              available: true,
              ...configuration,
              isDefault,
              monthlyBudgetMicros: preserveBudget
                ? assignment.monthlyBudgetMicros
                : data.monthlyBudgetMicros === null
                  ? null
                  : BigInt(data.monthlyBudgetMicros),
              bindingVersion: target.bindingVersion,
              revision: { increment: 1 },
            },
          });
        return workspaceIds;
      });
    }).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002")
        return deny("conflict");
      throw error;
    });
    for (const target of targets)
      await this.deps.realtime.publish(workspaceTopic(target), JSON.stringify({ connectionId }));
  }

  async overridesModels(actor: AIActor): Promise<boolean> {
    return runAsSystem("read workspace model override", () =>
      this.deps.prisma.$transaction(async (tx) => {
        await this.workspace(tx, actor);
        return (
          (await tx.aIWorkspacePolicy.findUnique({ where: { spaceId: actor.spaceId } }))
            ?.overridesModels ?? false
        );
      }),
    );
  }

  async resetWorkspaceModels(actor: AIActor): Promise<void> {
    await runAsSystem("restore the server model default", async () => {
      const admin = await this.serverAdmin(actor);
      await this.deps.prisma.$transaction(async (tx) => {
        await this.workspace(tx, actor, true);
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
        const account = await tx.serverAIConnection.findFirst({
          where: { localOrganizationId: admin.organizationId, isDefault: true },
        });
        if (!account?.defaultModelId || account.state !== "active") return deny("unavailable");
        if (await this.blockedByPolicy(account)) throw new ModelProviderBlockedError();
        await tx.workspaceAIConnection.updateMany({
          where: { spaceId: actor.spaceId },
          data: { enabled: false, isDefault: false, revision: { increment: 1 } },
        });
        const workspace = await this.workspace(tx, actor);
        const models = modelsSchema.parse(account.defaultAllowedModels ?? account.models);
        await tx.workspaceAIConnection.upsert({
          where: { spaceId_connectionId: { spaceId: actor.spaceId, connectionId: account.id } },
          create: {
            spaceId: actor.spaceId,
            connectionId: account.id,
            bindingVersion: workspace.version,
            enabled: true,
            isDefault: true,
            allowedModels: models,
            defaultModelId: account.defaultModelId,
          },
          update: {
            available: true,
            enabled: true,
            isDefault: true,
            allowedModels: models,
            defaultModelId: account.defaultModelId,
            bindingVersion: workspace.version,
            revision: { increment: 1 },
          },
        });
        await tx.aIWorkspacePolicy.upsert({
          where: { spaceId: actor.spaceId },
          create: { spaceId: actor.spaceId },
          update: { overridesModels: false, revision: { increment: 1 } },
        });
      });
    });
    await this.deps.realtime.publish(workspaceTopic(actor.spaceId), "changed");
  }

  async workspaceBudget(actor: AIActor): Promise<number | null> {
    return runAsSystem("read the authorized workspace AI budget", () =>
      this.deps.prisma.$transaction(async (tx) => {
        const workspace = await this.workspace(tx, actor);
        const policy = await tx.aIWorkspacePolicy.findFirst({
          where: {
            monthlyBudgetMicros: { not: null },
            space: {
              organizationId: workspace.organizationId,
              centralBinding: { bindingVersion: workspace.version },
            },
          },
        });
        return policy?.monthlyBudgetMicros == null ? null : Number(policy.monthlyBudgetMicros);
      }),
    );
  }

  async setWorkspaceBudget(actor: AIActor, monthlyBudgetMicros: number | null): Promise<void> {
    const budget = microsSchema.parse(monthlyBudgetMicros);
    await runAsSystem("set the organization AI usage limit", async () => {
      const admin = await this.serverAdmin(actor);
      await this.deps.prisma.$transaction(async (tx) => {
        await this.workspace(tx, actor, true);
        await tx.$queryRaw`SELECT id FROM organization WHERE id = ${admin.organizationId} FOR UPDATE`;
        if (budget === null) {
          await tx.aIWorkspacePolicy.updateMany({
            where: {
              space: {
                organizationId: admin.organizationId,
                centralBinding: { serverId: admin.serverId, bindingVersion: admin.bindingVersion },
              },
            },
            data: { monthlyBudgetMicros: null, revision: { increment: 1 } },
          });
          return;
        }
        await tx.aIWorkspacePolicy.upsert({
          where: { spaceId: actor.spaceId },
          create: {
            spaceId: actor.spaceId,
            monthlyBudgetMicros: budget === null ? null : BigInt(budget),
          },
          update: {
            monthlyBudgetMicros: budget === null ? null : BigInt(budget),
            revision: { increment: 1 },
          },
        });
      });
    });
  }

  notifyAccount(connectionId: string): Promise<void> {
    return this.deps.realtime.publish(accountTopic(connectionId), "changed");
  }

  async disable(actor: AIActor, connectionId: string): Promise<void> {
    await runAsSystem("disable an AI account without destroying its usage history", async () => {
      const admin = await this.serverAdmin(actor);
      await this.deps.prisma.serverAIConnection.update({
        where: { id: connectionId, localOrganizationId: admin.organizationId },
        data: { state: "disabled", revision: { increment: 1 } },
      });
    });
    await this.deps.realtime.publish(accountTopic(connectionId), "changed");
  }

  async choices(actor: AIActor): Promise<Array<{ connectionId: string; modelId: string }>> {
    return (await this.list(actor))
      .filter(
        (row) =>
          row.enabled &&
          !row.blockedByPolicy &&
          row.state === "active" &&
          (row.isDefault || row.fallback) &&
          row.defaultModelId &&
          row.allowedModels.includes(row.defaultModelId) &&
          row.models.includes(row.defaultModelId),
      )
      .sort(
        (a, b) =>
          Number(b.isDefault) - Number(a.isDefault) ||
          a.priority - b.priority ||
          a.id.localeCompare(b.id),
      )
      .map((row) => ({ connectionId: row.id, modelId: row.defaultModelId! }));
  }

  async claim(
    actor: AIActor,
    input: {
      operationId: string;
      connectionId: string;
      modelId: string;
      estimatedMicros: number | null;
      runId?: string;
    },
  ): Promise<AIExecutionClaim> {
    if (!input.operationId || input.operationId.length > 200) return deny("invalid");
    const estimated = microsSchema.parse(input.estimatedMicros);
    const estimate = BigInt(estimated ?? 0);
    const permission = await this.deps.authorizeWork(actor);
    if (!permission || permission.signal.aborted) {
      permission?.dispose();
      return deny("forbidden");
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([permission.signal, controller.signal]);
    const unsubscribe: Array<() => Promise<void>> = [];
    const dispose = () => {
      signal.removeEventListener("abort", dispose);
      const held = this.executions.get(input.operationId);
      if (held?.controller === controller) {
        clearTimeout(held.timer);
        this.executions.delete(input.operationId);
      }
      permission.dispose();
      for (const close of unsubscribe.splice(0)) void close().catch(() => undefined);
    };
    signal.addEventListener("abort", dispose, { once: true });
    try {
      for (const topic of [accountTopic(input.connectionId), workspaceTopic(actor.spaceId)])
        unsubscribe.push(
          await this.deps.realtime.subscribe(topic, (payload) => {
            if (topic === accountTopic(input.connectionId)) {
              controller.abort(new AIConnectionError("unavailable"));
              return;
            }
            try {
              if (
                (JSON.parse(payload) as { connectionId?: unknown }).connectionId ===
                input.connectionId
              )
                controller.abort(new AIConnectionError("unavailable"));
            } catch {
              controller.abort(new AIConnectionError("unavailable"));
            }
          }),
        );
      const startedAt = performance.now();
      await runAsSystem("atomically reserve AI account capacity and workspace budget", () =>
        this.deps.prisma.$transaction(async (tx) => {
          const workspace = await this.workspace(tx, actor);
          const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
          if (!identity || !["organization", "legacy"].includes(identity.modelSetupMode))
            return deny("forbidden");
          await tx.aIWorkspacePolicy.createMany({
            data: { spaceId: actor.spaceId },
            skipDuplicates: true,
          });
          await tx.$queryRaw`SELECT "spaceId" FROM ai_workspace_policies WHERE "spaceId" = ${actor.spaceId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${input.connectionId} FOR UPDATE`;
          const account = await tx.serverAIConnection.findUnique({
            where: { id: input.connectionId },
          });
          const assignment = await tx.workspaceAIConnection.findUnique({
            where: {
              spaceId_connectionId: { spaceId: actor.spaceId, connectionId: input.connectionId },
            },
          });
          const policy = await tx.aIWorkspacePolicy.findUniqueOrThrow({
            where: { spaceId: actor.spaceId },
          });
          if (
            account?.state !== "active" ||
            account.localOrganizationId !== workspace.organizationId ||
            !assignment?.available ||
            !assignment.enabled ||
            assignment.bindingVersion !== workspace.version ||
            !modelsSchema.parse(assignment.allowedModels).includes(input.modelId) ||
            !modelsSchema.parse(account.models).includes(input.modelId)
          )
            return deny("forbidden");
          assertModelProviderAllowed(account.provider);
          const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
          const dbNow = clock!.now;
          const previous = await tx.aIUsageReservation.findUnique({
            where: { operationId: input.operationId },
          });
          if (previous) return deny("conflict");
          if (account.blockedUntil && account.blockedUntil.getTime() > dbNow.getTime())
            return deny("busy");
          const active = await tx.aIUsageReservation.count({
            where: { connectionId: account.id, completedAt: null, leaseUntil: { gt: dbNow } },
          });
          if (active >= account.concurrencyLimit) return deny("busy");
          const period = dbNow.toISOString().slice(0, 7);
          const used = await tx.$queryRaw<
            Array<{ account: bigint; workspace: bigint; assignment: bigint }>
          >`SELECT
          COALESCE(SUM(COALESCE("chargedMicros", "reservedMicros")) FILTER (WHERE "connectionId" = ${account.id}), 0)::bigint AS account,
          COALESCE(SUM(COALESCE("chargedMicros", "reservedMicros")) FILTER (WHERE "spaceId" = ${actor.spaceId}), 0)::bigint AS workspace,
          COALESCE(SUM(COALESCE("chargedMicros", "reservedMicros")) FILTER (WHERE "spaceId" = ${actor.spaceId} AND "connectionId" = ${account.id}), 0)::bigint AS assignment
          FROM ai_usage_reservations WHERE period = ${period} AND ("connectionId" = ${account.id} OR "spaceId" = ${actor.spaceId})`;
          const [unknown] = await tx.$queryRaw<
            Array<{ account: boolean; workspace: boolean; assignment: boolean }>
          >`SELECT
            EXISTS (SELECT 1 FROM ai_usage_reservations WHERE period = ${period} AND "connectionId" = ${account.id} AND NOT "estimateKnown" AND "chargedMicros" IS NULL) AS account,
            EXISTS (SELECT 1 FROM ai_usage_reservations WHERE period = ${period} AND "spaceId" = ${actor.spaceId} AND NOT "estimateKnown" AND "chargedMicros" IS NULL) AS workspace,
            EXISTS (SELECT 1 FROM ai_usage_reservations WHERE period = ${period} AND "spaceId" = ${actor.spaceId} AND "connectionId" = ${account.id} AND NOT "estimateKnown" AND "chargedMicros" IS NULL) AS assignment`;
          if (
            (account.monthlyBudgetMicros !== null && (estimated === null || unknown!.account)) ||
            (policy.monthlyBudgetMicros !== null && (estimated === null || unknown!.workspace)) ||
            (assignment.monthlyBudgetMicros !== null && (estimated === null || unknown!.assignment))
          )
            return deny("budget");
          for (const [limit, spent] of [
            [account.monthlyBudgetMicros, used[0]!.account],
            [policy.monthlyBudgetMicros, used[0]!.workspace],
            [assignment.monthlyBudgetMicros, used[0]!.assignment],
          ] as const)
            if (limit !== null && spent + estimate > limit) return deny("budget");
          signal.throwIfAborted();
          if (performance.now() >= startedAt + LEASE_MS) return deny("unavailable");
          await tx.aIUsageReservation.create({
            data: {
              operationId: input.operationId,
              connectionId: account.id,
              spaceId: actor.spaceId,
              userId: actor.userId,
              runId: input.runId,
              modelId: input.modelId,
              period,
              reservedMicros: estimate,
              estimateKnown: estimated !== null,
              accountRevision: account.revision,
              assignmentRevision: assignment.revision,
              bindingVersion: workspace.version,
              leaseUntil: new Date(dbNow.getTime() + LEASE_MS),
            },
          });
        }),
      );
      signal.throwIfAborted();
      const deadline = startedAt + LEASE_MS;
      if (performance.now() >= deadline) return deny("unavailable");
      const claim: AIExecutionClaim = {
        operationId: input.operationId,
        connectionId: input.connectionId,
        modelId: input.modelId,
        scope: { ...actor },
        signal,
        dispose,
      };
      const timer = setTimeout(
        () => controller.abort(new AIConnectionError("unavailable")),
        Math.max(0, deadline - performance.now()),
      );
      timer.unref?.();
      this.issued.add(claim);
      this.executions.set(claim.operationId, { claim, controller, deadline, timer });
      return claim;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private live(claim: AIExecutionClaim) {
    claim.signal.throwIfAborted();
    const held = this.executions.get(claim.operationId);
    if (held?.claim !== claim) return deny("forbidden");
    if (performance.now() >= held.deadline) {
      held.controller.abort(new AIConnectionError("unavailable"));
      return deny("forbidden");
    }
    return held;
  }

  async withAccess<T>(actor: AIActor, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const permission = await this.deps.authorizeWork(actor);
    if (!permission) return deny("forbidden");
    try {
      permission.signal.throwIfAborted();
      const value = await run(permission.signal);
      permission.signal.throwIfAborted();
      return value;
    } finally {
      permission.dispose();
    }
  }

  /** Called inside the account-specific refresh transaction; never returned by an API handler. */
  async selection(
    tx: Prisma.TransactionClient,
    actor: AIActor,
    connectionId: string,
    modelId: string,
  ) {
    const workspace = await this.workspace(tx, actor);
    const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
    if (!identity || !["organization", "legacy"].includes(identity.modelSetupMode))
      return deny("forbidden");
    const account = await tx.serverAIConnection.findUnique({ where: { id: connectionId } });
    const assignment = await tx.workspaceAIConnection.findUnique({
      where: { spaceId_connectionId: { spaceId: actor.spaceId, connectionId } },
    });
    if (
      account?.state !== "active" ||
      account.localOrganizationId !== workspace.organizationId ||
      !assignment?.available ||
      !assignment.enabled ||
      assignment.bindingVersion !== workspace.version ||
      !modelsSchema.parse(assignment.allowedModels).includes(modelId) ||
      !modelsSchema.parse(account.models).includes(modelId)
    )
      return deny("forbidden");
    assertModelProviderAllowed(account.provider);
    if (account.blockedUntil) {
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      if (account.blockedUntil.getTime() > clock!.now.getTime()) return deny("busy");
    }
    return { account, assignment };
  }

  /** Refresh and provider calls must revalidate the assignment immediately before using credentials. */
  async validate(claim: AIExecutionClaim) {
    const held = this.live(claim);
    return runAsSystem("recheck an AI execution reservation before provider access", () =>
      this.deps.prisma.$transaction((tx) => this.validateInTransaction(tx, claim)),
    ).catch((error) => {
      held.controller.abort(new AIConnectionError("forbidden"));
      throw error;
    });
  }

  async validateInTransaction(tx: Prisma.TransactionClient, claim: AIExecutionClaim) {
    this.live(claim);
    const workspace = await this.workspace(tx, claim.scope);
    const identity = await tx.installationIdentity.findUnique({ where: { id: "local" } });
    if (!identity || !["organization", "legacy"].includes(identity.modelSetupMode))
      return deny("forbidden");
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const reservation = await tx.aIUsageReservation.findUnique({
      where: { operationId: claim.operationId },
    });
    const account = await tx.serverAIConnection.findUnique({
      where: { id: claim.connectionId },
    });
    const assignment = await tx.workspaceAIConnection.findUnique({
      where: {
        spaceId_connectionId: {
          spaceId: claim.scope.spaceId,
          connectionId: claim.connectionId,
        },
      },
    });
    if (
      !reservation ||
      !account ||
      account.state !== "active" ||
      !assignment?.enabled ||
      !assignment.available ||
      reservation.userId !== claim.scope.userId ||
      reservation.spaceId !== claim.scope.spaceId ||
      reservation.connectionId !== claim.connectionId ||
      reservation.modelId !== claim.modelId ||
      reservation.completedAt ||
      reservation.leaseUntil.getTime() <= clock!.now.getTime() ||
      account.revision !== reservation.accountRevision ||
      assignment.revision !== reservation.assignmentRevision ||
      assignment.bindingVersion !== workspace.version ||
      reservation.bindingVersion !== workspace.version
    )
      return deny("forbidden");
    assertModelProviderAllowed(account.provider);
    return { account, assignment, reservation };
  }

  async heartbeat(claim: AIExecutionClaim): Promise<void> {
    const startedAt = performance.now();
    await this.validate(claim);
    const updated = await runAsSystem(
      "renew a bounded AI execution lease",
      () => this.deps.prisma.$executeRaw`UPDATE ai_usage_reservations
      SET "leaseUntil" = clock_timestamp() + interval '30 seconds'
      WHERE "operationId" = ${claim.operationId} AND "completedAt" IS NULL AND "leaseUntil" > clock_timestamp()`,
    );
    const held = this.executions.get(claim.operationId);
    if (updated !== 1 || held?.claim !== claim || performance.now() >= held.deadline)
      return deny("forbidden");
    clearTimeout(held.timer);
    held.deadline = startedAt + LEASE_MS;
    held.timer = setTimeout(
      () => held.controller.abort(new AIConnectionError("unavailable")),
      Math.max(0, held.deadline - performance.now()),
    );
    held.timer.unref?.();
  }

  /** A quota response pauses only the exact account revision used by this provider attempt. */
  async cooldown(claim: AIExecutionClaim, retryAfter: string | null): Promise<void> {
    if (!this.issued.has(claim)) return deny("forbidden");
    let delay = 60_000;
    if (retryAfter && retryAfter.length <= 128) {
      const raw = retryAfter.trim();
      const parsed = /^\d+(?:\.\d+)?$/.test(raw)
        ? Number(raw) * 1000
        : Date.parse(raw) - Date.now();
      if (Number.isFinite(parsed)) delay = Math.max(1000, Math.min(86_400_000, parsed));
    }
    await runAsSystem(
      "coordinate provider quota cooldown for one AI account",
      () =>
        this.deps.prisma.$executeRaw`UPDATE server_ai_connections AS account
        SET "blockedUntil" = GREATEST(COALESCE(account."blockedUntil", clock_timestamp()), clock_timestamp() + ${delay} * interval '1 millisecond')
        FROM ai_usage_reservations AS reservation
        WHERE reservation."operationId" = ${claim.operationId}
          AND reservation."connectionId" = ${claim.connectionId}
          AND reservation."spaceId" = ${claim.scope.spaceId}
          AND reservation."userId" = ${claim.scope.userId}
          AND account.id = reservation."connectionId"
          AND account.revision = reservation."accountRevision"`,
    );
  }

  async settle(claim: AIExecutionClaim, actualMicros: number | null): Promise<void> {
    if (!this.issued.has(claim)) return deny("forbidden");
    const cost = microsSchema.parse(actualMicros);
    try {
      await runAsSystem("reconcile AI spend once without erasing unknown provider charges", () =>
        this.deps.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "spaceId" FROM ai_workspace_policies WHERE "spaceId" = ${claim.scope.spaceId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM server_ai_connections WHERE id = ${claim.connectionId} FOR UPDATE`;
          const current = await tx.aIUsageReservation.findUnique({
            where: { operationId: claim.operationId },
          });
          if (
            !current ||
            current.userId !== claim.scope.userId ||
            current.spaceId !== claim.scope.spaceId ||
            current.connectionId !== claim.connectionId
          )
            return deny("forbidden");
          await tx.aIUsageReservation.updateMany({
            where: {
              operationId: claim.operationId,
              OR: [{ completedAt: null }, ...(cost !== null ? [{ chargedMicros: null }] : [])],
            },
            data: {
              completedAt: current.completedAt ?? new Date(),
              chargedMicros: cost === null ? null : BigInt(cost),
              leaseUntil: new Date(0),
            },
          });
        }),
      );
    } finally {
      claim.dispose();
    }
  }
  dispose(): void {
    for (const execution of this.executions.values())
      execution.controller.abort(new AIConnectionError("unavailable"));
  }
}
