// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunModel, SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { modelFromAIConnection } from "./ai-connection-model.js";
import { parseModelSecret, secretValuesToRedact } from "./pi-oauth.js";
import type { InstallationModelScope, ServerAIModels } from "./server-ai-runtime.js";

/** Find the organization policy for this Space. A database error must never mean no policy. */
export async function findWorkspaceModelPolicy(prisma: PrismaClient, spaceId: string) {
  return prisma.workspaceModelPolicy.findFirst({
    where: { organization: { spaces: { some: { id: spaceId } } } },
  });
}

/** Resolve only on the server; callers must never return this model over an API. */
export async function resolveWorkspaceModel(
  deps: {
    prisma: PrismaClient;
    secretStore: SecretStore;
    mcpAllowPrivateEndpoint?: boolean;
    serverAIModels?: ServerAIModels;
  },
  spaceId: string,
  scope?: InstallationModelScope,
  selection?: { provider: string; modelId: string; connectionId?: string },
): Promise<{ model: AgentRunModel; redact: string[]; secretId: string } | null> {
  if (deps.serverAIModels && scope) {
    const managed = await deps.serverAIModels.resolve(scope, selection);
    if (managed) return managed;
  }
  const policy = await findWorkspaceModelPolicy(deps.prisma, spaceId);
  if (!policy) return null;
  // Do not leak store or provider errors: they can contain secret material.
  try {
    const secret = parseModelSecret(await deps.secretStore.load(policy.secretRef, policy.secretId));
    if (secret.kind === "oauth") throw new Error("Unsupported workspace credential");
    const model = modelFromAIConnection(
      { provider: policy.provider, modelId: policy.modelId },
      secret,
      secret.kind === "api_key" ? secret.key : (secret.apiKey ?? ""),
      { allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint },
    );
    return { model, redact: secretValuesToRedact(secret), secretId: policy.secretId };
  } catch {
    throw new Error(
      "The workspace model connection is unavailable. Ask the workspace owner to check it.",
    );
  }
}
