// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunModel } from "@orkbot/adapter-kit";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { cloudflareProviderEnv } from "./cloudflare-ai-gateway.js";
import { modelConnectionRouting } from "./model-connection-metadata.js";
import { assertAllowedOpenAiCompatibleUrl } from "./openai-compatible-url.js";
import type { StoredModelSecret } from "./pi-oauth.js";

/** Translation stays inside the server adapter; this object must never be sent to a client. */
export function modelFromAIConnection(
  choice: { provider: string; modelId: string },
  secret: StoredModelSecret,
  apiKey: string,
  options: { allowPrivateEndpoint?: boolean } = {},
): AgentRunModel {
  if (!apiKey.trim() && secret.kind !== "openai_compatible")
    throw new Error("AI connection is unavailable");
  const model: AgentRunModel = {
    provider: choice.provider,
    id: choice.modelId,
    apiKey,
    maxTokens: secret.maxTokens,
  };
  if (secret.kind === "openai_compatible") {
    if (choice.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) throw new Error("Invalid AI connection");
    assertAllowedOpenAiCompatibleUrl(secret.baseUrl, {
      allowPublic: true,
      allowPrivate: options.allowPrivateEndpoint === true,
    });
    Object.assign(model, {
      baseUrl: secret.baseUrl,
      apiProtocol: secret.apiProtocol,
      headers: secret.headers,
      allowPrivateEndpoint: options.allowPrivateEndpoint === true,
      reasoning: secret.reasoning,
      thinkingLevel: secret.thinkingLevel,
      acceptsImages: secret.visionModelIds?.includes(choice.modelId),
      maxImagesPerPrompt: secret.maxImagesPerPrompt,
      contextWindow: secret.contextWindow,
      cacheCapabilities: secret.cacheCapabilities,
    });
  } else {
    if (choice.provider === OPENAI_COMPATIBLE_PROVIDER_ID) throw new Error("Invalid AI connection");
    if (secret.kind === "oauth") {
      if (secret.reconnectRequired) throw new Error("AI account requires reconnection");
      model.oauth = { credential: { ...secret.credential, type: "oauth" } };
    } else {
      const routing = modelConnectionRouting({ provider: choice.provider }, secret);
      cloudflareProviderEnv({ provider: choice.provider, ...routing });
      Object.assign(model, {
        routing: routing?.routing,
        accountId: routing?.accountId,
        gatewayId: routing?.gatewayId,
        contextWindow: secret.contextWindow,
        cacheCapabilities: secret.cacheCapabilities,
      });
    }
  }
  return model;
}
