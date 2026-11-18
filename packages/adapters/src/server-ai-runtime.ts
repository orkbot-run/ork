// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import type { ModelRoleChoice } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem, workspaceAdmissionBinding } from "@orkbot/db";
import type { AIActor, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";
import { serverAIModel } from "./server-ai-model.js";

export type InstallationModelScope = {
  userId: string;
  spaceId: string;
  centralWorkspaceId?: string | null;
  workspaceMembershipVersion?: string | null;
};

/** The execution model boundary never consults personal credentials for managed workspaces. */
export class ServerAIModels {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      secrets: SecretStore;
      catalog: ServerAICatalog;
      allowPrivateEndpoint?: boolean;
    },
  ) {}

  async actor(scope: InstallationModelScope): Promise<AIActor | null> {
    return runAsSystem("resolve the workspace's exact installation AI admission", async () => {
      const binding = await workspaceAdmissionBinding(this.deps.prisma, scope.spaceId);
      if (!binding) return null;
      if (
        binding.spaceId !== scope.spaceId &&
        !(await this.deps.prisma.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
          select: { userId: true },
        }))
      )
        throw new AIConnectionError("forbidden");
      const access = await this.deps.prisma.centralWorkspaceAccess.findUnique({
        where: { workspaceId_userId: { workspaceId: binding.id, userId: scope.userId } },
      });
      if (
        binding.state !== "ready" ||
        !access?.active ||
        (scope.centralWorkspaceId !== undefined && scope.centralWorkspaceId !== binding.id) ||
        (scope.workspaceMembershipVersion !== undefined &&
          scope.workspaceMembershipVersion !== access.membershipVersion)
      )
        throw new AIConnectionError("forbidden");
      return {
        userId: scope.userId,
        spaceId: scope.spaceId,
        membershipVersion: access.membershipVersion,
      };
    });
  }

  async assignedAccounts(scope: InstallationModelScope) {
    const actor = await this.actor(scope);
    if (!actor || (await this.personalModelsAllowed(scope))) return null;
    if ((await this.deps.catalog.setupMode(actor)) === "pending") return [];
    return (await this.deps.catalog.list(actor)).filter(
      (row) => row.enabled && row.state === "active",
    );
  }

  async personalModelsAllowed(scope: InstallationModelScope): Promise<boolean | null> {
    const actor = await this.actor(scope);
    if (!actor) return null;
    const mode = await this.deps.catalog.setupMode(actor);
    if (mode === "personal") return true;
    if (mode !== "legacy") return false;
    return !(await this.deps.catalog.hasConfiguredModel(actor));
  }

  private async isServerConnection(actor: AIActor, connectionId: string): Promise<boolean> {
    return runAsSystem("check a pinned server model connection", async () =>
      Boolean(
        await this.deps.prisma.serverAIConnection.findFirst({
          where: { id: connectionId, organization: { spaces: { some: { id: actor.spaceId } } } },
          select: { id: true },
        }),
      ),
    );
  }

  /** Validate picker metadata without loading credentials or contacting a provider. */
  async validateSelection(
    scope: InstallationModelScope,
    selection?: { provider: string; modelId: string; connectionId?: string },
  ): Promise<boolean | null> {
    const actor = await this.actor(scope);
    if (!actor) return null;
    if (await this.personalModelsAllowed(scope)) {
      return selection?.connectionId &&
        (await this.isServerConnection(actor, selection.connectionId))
        ? false
        : null;
    }
    if ((await this.deps.catalog.setupMode(actor)) === "pending") return false;
    if (!selection) return true;
    return Boolean(await this.selectedAccount(actor, selection));
  }

  private async selectedAccount(
    actor: AIActor,
    selection: { provider: string; modelId: string; connectionId?: string },
  ) {
    const allowed = (await this.deps.catalog.list(actor)).filter(
      (row) =>
        row.enabled &&
        row.state === "active" &&
        row.provider === selection.provider &&
        row.allowedModels.includes(selection.modelId) &&
        row.models.includes(selection.modelId),
    );
    if (selection.connectionId) return allowed.find((row) => row.id === selection.connectionId);
    const primary = (await this.deps.catalog.choices(actor))[0];
    return (
      allowed.find((row) => row.id === primary?.connectionId) ??
      (allowed.length === 1 ? allowed[0] : undefined)
    );
  }

  async resolve(
    scope: InstallationModelScope,
    selection?: { provider: string; modelId: string; connectionId?: string },
  ) {
    const actor = await this.actor(scope);
    if (!actor) return null;
    if (await this.personalModelsAllowed(scope)) {
      if (selection?.connectionId && (await this.isServerConnection(actor, selection.connectionId)))
        throw new AIConnectionError("unavailable");
      return null;
    }
    if ((await this.deps.catalog.setupMode(actor)) === "pending")
      throw new AIConnectionError("unavailable");
    if (!selection) {
      const choices = await this.deps.catalog.choices(actor);
      for (const choice of choices) {
        try {
          return {
            ...(await serverAIModel(this.deps, actor, choice.connectionId, choice.modelId)),
            secretId: choice.connectionId,
          };
        } catch (error) {
          if (
            !(error instanceof AIConnectionError) ||
            !["unavailable", "busy"].includes(error.code)
          )
            throw error;
        }
      }
      throw new AIConnectionError("unavailable");
    }
    const account = await this.selectedAccount(actor, selection);
    if (!account) throw new AIConnectionError("unavailable");
    const connectionId = account.id;
    const modelId = selection.modelId;
    return {
      ...(await serverAIModel(this.deps, actor, connectionId, modelId)),
      secretId: connectionId,
    };
  }

  async fallbacks(scope: InstallationModelScope): Promise<ModelRoleChoice[] | null> {
    const actor = await this.actor(scope);
    if (!actor) return null;
    if (await this.personalModelsAllowed(scope)) return null;
    if ((await this.deps.catalog.setupMode(actor)) === "pending") return [];
    return (await this.deps.catalog.list(actor))
      .filter(
        (row) =>
          row.enabled &&
          row.fallback &&
          row.state === "active" &&
          row.defaultModelId &&
          row.allowedModels.includes(row.defaultModelId) &&
          row.models.includes(row.defaultModelId),
      )
      .map((row) => ({
        provider: row.provider,
        modelId: row.defaultModelId!,
        credentialId: row.id,
      }));
  }
}
