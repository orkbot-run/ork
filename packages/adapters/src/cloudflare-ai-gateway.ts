// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 auth is preserved; neutral routing translation follows LICENSE.md.

import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgentRunModel } from "@orkbot/adapter-kit";
import {
  cloudflareModelConfigMessage,
  cloudflareModelRouting,
  isCloudflareModelProvider,
} from "./cloudflare-model-config.js";
import { modelConnectionRouting } from "./model-connection-metadata.js";

const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID_ENV = "CLOUDFLARE_GATEWAY_ID";

/**
 * Cloudflare requires tenant routing alongside the key. Workers AI needs an
 * account; AI Gateway additionally needs a gateway. Saved routing wins over host env.
 */
export function cloudflareProviderEnv(
  model: Pick<AgentRunModel, "provider" | "routing" | "accountId" | "gatewayId">,
): Record<string, string> | undefined {
  if (!isCloudflareModelProvider(model.provider)) return undefined;
  const canonical = modelConnectionRouting({ provider: model.provider }, model);
  const routing = cloudflareModelRouting({ provider: model.provider, ...canonical });
  if (!routing) throw new Error(cloudflareModelConfigMessage(model.provider));
  return {
    [CLOUDFLARE_ACCOUNT_ID_ENV]: routing.accountId,
    ...(routing.gatewayId ? { [CLOUDFLARE_GATEWAY_ID_ENV]: routing.gatewayId } : {}),
  };
}

export function withCloudflareAuth(
  model: Pick<AgentRunModel, "provider" | "routing" | "accountId" | "gatewayId">,
  options: ModelsSimpleStreamOptions | undefined,
): ModelsSimpleStreamOptions | undefined {
  const env = cloudflareProviderEnv(model);
  if (!env) return options;
  return { ...options, env: { ...options?.env, ...env } };
}
