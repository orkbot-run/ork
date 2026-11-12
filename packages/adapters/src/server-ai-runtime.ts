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

  async resolve(
    scope: InstallationModelScope,
    selection?: { provider: string; modelId: string; connectionId?: string },
  ) {
    const actor = await this.actor(scope);
    if (!actor) return null;
    const allowed = await this.deps.catalog.list(actor);
    const choices = await this.deps.catalog.choices(actor);
    if (!selection) {
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
    const primary = choices[0];
    let connectionId = selection?.connectionId ?? primary?.connectionId;
    const modelId = selection?.modelId ?? primary?.modelId;
    if (selection && !selection.connectionId) {
      const candidates = allowed.filter(
        (row) =>
          row.enabled &&
          row.state === "active" &&
          row.provider === selection.provider &&
          row.allowedModels.includes(selection.modelId) &&
          row.models.includes(selection.modelId),
      );
      if (!candidates.some((row) => row.id === connectionId))
        connectionId = candidates.length === 1 ? candidates[0]!.id : undefined;
    }
    const account = allowed.find((row) => row.id === connectionId);
    if (
      !connectionId ||
      !modelId ||
      !account ||
      (selection && account.provider !== selection.provider)
    )
      throw new AIConnectionError("unavailable");
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
