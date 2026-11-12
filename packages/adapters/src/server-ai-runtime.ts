// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import type { ModelRoleChoice } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
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
      const binding = await this.deps.prisma.centralWorkspaceBinding.findUnique({
        where: { spaceId: scope.spaceId },
      });
      if (!binding) return null;
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
    return actor
      ? (await this.deps.catalog.list(actor)).filter((row) => row.enabled && row.state === "active")
      : null;
  }

  /** Validate picker metadata without loading credentials or contacting a provider. */
  async validateSelection(
    scope: InstallationModelScope,
    selection?: { provider: string; modelId: string; connectionId?: string },
  ): Promise<boolean | null> {
    const actor = await this.actor(scope);
    if (!actor) return null;
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
