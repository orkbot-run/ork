// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";

const LimitsSchema = z
  .object({
    maxTools: z.number().int().min(1).max(10_000).default(250),
    maxPages: z.number().int().min(1).max(100).default(20),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
  })
  .strict();

export type McpDiscoveryLimits = z.infer<typeof LimitsSchema>;
export type McpDiscoveryDiagnostic = {
  reason: "tool_limit" | "page_limit" | "byte_limit" | "cursor_cycle";
  toolsListed: number;
  pagesRead: number;
  catalogBytes: number;
};
export type McpDiscoveryResult<T> = { tools: T[]; diagnostic?: McpDiscoveryDiagnostic };

const DISCOVERY_MESSAGES: Record<McpDiscoveryDiagnostic["reason"], string> = {
  tool_limit: "Tool catalog is incomplete: discovery reached the configured tool limit.",
  page_limit: "Tool catalog is incomplete: discovery reached the configured page limit.",
  byte_limit: "Tool catalog is incomplete: discovery reached the configured catalog size limit.",
  cursor_cycle: "Tool catalog is incomplete: the server repeated a pagination cursor.",
};

export function mcpDiscoveryMessage(diagnostic: McpDiscoveryDiagnostic | undefined): string | null {
  return diagnostic ? DISCOVERY_MESSAGES[diagnostic.reason] : null;
}

export function mcpDiscoveryLimits(value: Partial<McpDiscoveryLimits> = {}): McpDiscoveryLimits {
  return LimitsSchema.parse(value);
}

/** Invalid explicit settings stop startup instead of silently widening or disabling bounds. */
export function mcpDiscoveryLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpDiscoveryLimits {
  const number = (value: string | undefined) => (value?.trim() ? Number(value) : undefined);
  return mcpDiscoveryLimits({
    maxTools: number(env.MCP_DISCOVERY_MAX_TOOLS),
    maxPages: number(env.MCP_DISCOVERY_MAX_PAGES),
    maxBytes: number(env.MCP_DISCOVERY_MAX_BYTES),
  });
}
