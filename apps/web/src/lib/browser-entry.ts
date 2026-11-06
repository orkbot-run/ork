// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Protocol callbacks finish an existing native flow; they do not expose product screens. */
export function browserEntry(path: string, native: boolean): "native" | "callback" | "connect" {
  if (native) return "native";
  return [
    "/sso/callback",
    "/integrations/callback",
    "/mcp/oauth/callback",
    "/messaging/slack/callback",
  ].includes(path)
    ? "callback"
    : "connect";
}
