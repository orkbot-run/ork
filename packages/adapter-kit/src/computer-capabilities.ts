// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerCapabilities } from "@orkbot/contracts";
import type { SandboxProvider } from "./interfaces.js";
import type { ComputerRef } from "./types.js";

export interface ComputerCapabilityTarget {
  homeKey?: string;
  ownerUserId?: string;
  computer?: Pick<ComputerRef, "kind" | "botId" | "providerRef">;
}

/** Projection only: no screen connection, verification, or provisioning. */
export async function inspectComputerCapabilities(
  provider: SandboxProvider,
  input: ComputerCapabilityTarget = {},
): Promise<ComputerCapabilities> {
  if (provider.computerCapabilities) return provider.computerCapabilities(input);
  const capabilities = provider.describe().capabilities;
  return {
    start: capabilities.provisioning !== false,
    screen: capabilities.graphical,
    control: capabilities.graphical && capabilities.takeover,
    terminal: capabilities.pty && typeof provider.connectTerminal === "function",
  };
}
