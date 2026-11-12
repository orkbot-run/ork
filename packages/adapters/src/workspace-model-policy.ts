// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunModel, SecretStore } from "@orkbot/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { cloudflareProviderEnv } from "./cloudflare-ai-gateway.js";
import { modelConnectionRouting } from "./model-connection-metadata.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";
import { parseModelSecret, secretValuesToRedact } from "./pi-oauth.js";

export type WorkspaceModelOption = {
  provider: string;
  modelId: string;
  secretId: string;
  secretRef: string;
};

/** Reject corrupt policy data instead of silently allowing a personal model. */
export function workspaceModelOptions(
  policy: WorkspaceModelOption & { additionalModels?: unknown },
): WorkspaceModelOption[] {
  const extra = policy.additionalModels ?? [];
  if (!Array.isArray(extra) || extra.length > 32) throw new Error("Invalid workspace model policy");
  const options: WorkspaceModelOption[] = [policy];
  for (const item of extra) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      ![item.provider, item.modelId, item.secretId, item.secretRef].every(
        (value) => typeof value === "string" && value.length > 0,
      )
    )
      throw new Error("Invalid workspace model policy");
    if (
      options.some((option) => option.provider === item.provider && option.modelId === item.modelId)
    )
      throw new Error("Duplicate workspace model");
    options.push({
      provider: item.provider,
      modelId: item.modelId,
      secretId: item.secretId,
      secretRef: item.secretRef,
    });
  }
  return options;
}

/** Find the organization policy for this Space. A database error must never mean no policy. */
export async function findWorkspaceModelPolicy(prisma: PrismaClient, spaceId: string) {
  return prisma.workspaceModelPolicy.findFirst({
    where: { organization: { spaces: { some: { id: spaceId } } } },
  });
}

/** Resolve only on the server; callers must never return this model over an API. */
export async function resolveWorkspaceModel(
  deps: { prisma: PrismaClient; secretStore: SecretStore; mcpAllowPrivateEndpoint?: boolean },
  spaceId: string,
  preferred?: { provider: string | null; modelId: string | null } | null,
): Promise<{ model: AgentRunModel; redact: string[]; secretId: string } | null> {
  const policy = await findWorkspaceModelPolicy(deps.prisma, spaceId);
  if (!policy) return null;
  // Do not leak store or provider errors: they can contain secret material.
  try {
    const options = workspaceModelOptions(policy);
    const selected =
      options.find(
        (item) => item.provider === preferred?.provider && item.modelId === preferred?.modelId,
      ) ?? options[0]!;
    const secret = parseModelSecret(
      await deps.secretStore.load(selected.secretRef, selected.secretId),
    );
    if (secret.kind === "oauth") throw new Error("Unsupported workspace credential");
    const model: AgentRunModel = { provider: selected.provider, id: selected.modelId };
    if (secret.kind === "openai_compatible") {
      if (selected.provider !== OPENAI_COMPATIBLE_PROVIDER_ID || !secret.apiKey?.trim())
        throw new Error("Invalid workspace credential");
      assertAllowedOpenAiCompatibleUrl(secret.baseUrl, {
        allowPublic: true,
        allowPrivate: deps.mcpAllowPrivateEndpoint === true,
      });
      Object.assign(model, {
        apiKey: secret.apiKey,
        baseUrl: secret.baseUrl,
        apiProtocol: secret.apiProtocol,
        headers: secret.headers,
        allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
        reasoning: secret.reasoning,
        thinkingLevel: secret.thinkingLevel,
        acceptsImages: secret.visionModelIds?.includes(selected.modelId),
        maxImagesPerPrompt: secret.maxImagesPerPrompt,
        maxTokens: secret.maxTokens,
        contextWindow: secret.contextWindow,
        cacheCapabilities: secret.cacheCapabilities,
      });
    } else {
      if (!secret.key.trim() || selected.provider === OPENAI_COMPATIBLE_PROVIDER_ID)
        throw new Error("Invalid workspace credential");
      const routing = modelConnectionRouting({ provider: selected.provider }, secret);
      cloudflareProviderEnv({ provider: selected.provider, ...routing });
      Object.assign(model, {
        apiKey: secret.key,
        routing: routing?.routing,
        accountId: routing?.accountId,
        gatewayId: routing?.gatewayId,
        maxTokens: secret.maxTokens,
        contextWindow: secret.contextWindow,
        cacheCapabilities: secret.cacheCapabilities,
      });
    }
    return { model, redact: secretValuesToRedact(secret), secretId: selected.secretId };
  } catch {
    throw new Error(
      "The workspace model connection is unavailable. Ask the workspace owner to check it.",
    );
  }
}
