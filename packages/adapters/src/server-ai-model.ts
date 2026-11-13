// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunModel, SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { modelFromAIConnection } from "./ai-connection-model.js";
import { toOAuthCredential } from "./pi-credentials.js";
import { secretValuesToRedact } from "./pi-oauth.js";
import { resolveServerAIAuth, retireServerAIAuth } from "./server-ai-auth.js";
import type { AIActor, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";
import { serverAIObserver } from "./server-ai-observer.js";

/** Resolve the selected server account without consulting a personal or deployment fallback. */
export async function serverAIModel(
  deps: {
    prisma: PrismaClient;
    secrets: SecretStore;
    catalog: ServerAICatalog;
    allowPrivateEndpoint?: boolean;
  },
  actor: AIActor,
  connectionId: string,
  modelId: string,
): Promise<{ model: AgentRunModel; redact: string[]; dispose(): Promise<void> }> {
  const resolved = await resolveServerAIAuth(deps, actor, connectionId, modelId);
  let model: AgentRunModel;
  try {
    model = modelFromAIConnection(
      { provider: resolved.provider, modelId },
      resolved.value.secret,
      resolved.value.apiKey,
      { allowPrivateEndpoint: deps.allowPrivateEndpoint },
    );
  } catch {
    throw new AIConnectionError("unavailable");
  }
  const observer = serverAIObserver(deps.catalog, actor, connectionId, modelId, resolved.provider);
  model.connectionId = connectionId;
  model.callObserver = observer;
  if (model.oauth) {
    model.oauth.retire = (_reason, _detail, failed) =>
      retireServerAIAuth(deps, actor, connectionId, modelId, failed);
    model.oauth.persist = async (next) => {
      await resolveServerAIAuth(deps, actor, connectionId, modelId, {
        modify: async () => toOAuthCredential(next),
      });
    };
    model.oauth.refresh = async (update, signal) => {
      signal?.throwIfAborted();
      const next = await resolveServerAIAuth(deps, actor, connectionId, modelId, {
        modify: async (current) => {
          signal?.throwIfAborted();
          const result = await update({ ...current, type: "oauth" });
          return result ? toOAuthCredential(result) : undefined;
        },
      });
      return next.value.secret.kind === "oauth"
        ? { ...next.value.secret.credential, type: "oauth" }
        : undefined;
    };
  }
  return {
    model,
    redact: [...secretValuesToRedact(resolved.value.secret), resolved.value.apiKey].filter(Boolean),
    dispose: () => observer.dispose(),
  };
}
