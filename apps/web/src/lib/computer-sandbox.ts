// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

import { t } from "@lingui/core/macro";
import type { ComputerCapabilities, Me } from "@orkbot/contracts";
import { captureRpcContext } from "./rpc";
import { errorText } from "./user-error";

export function computersAreUnavailable(
  capabilities: ComputerCapabilities | null | undefined,
): boolean {
  return capabilities?.start !== true;
}

export type SandboxAvailabilityPhase = "idle" | "loading" | "recovered" | "unavailable" | "failure";

export async function refreshSandboxFromServer(origin = captureRpcContext()): Promise<Me> {
  const [health, me] = await Promise.all([origin.client.health(), origin.client.me()]);
  if (!origin.isCurrent()) throw new DOMException("Session changed", "AbortError");
  if (!health.ok) throw new Error("Server health check failed");
  return me;
}

export function sandboxCheckFailureMessage(error: unknown): string {
  return errorText(error, t`Could not reach the server`);
}
