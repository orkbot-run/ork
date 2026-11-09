// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatePhase } from "@orkbot/contracts";

/** Redeploy the operator-configured channel; this does not select an immutable target. */
export interface ServerUpdateAdapter {
  readonly channel: "stable" | "preview";
  readonly channelSelectable?: boolean;
  check(channel?: "stable" | "preview"): Promise<{ revision: string; version: string } | null>;
  operation?(): Promise<{
    revision: string;
    idempotencyKey: string;
    state: "accepted" | "running" | "succeeded" | "failed" | "unknown";
    phase?: ServerUpdatePhase;
  } | null>;
  /**
   * Call the guard once after eligibility checks, immediately before the irreversible request.
   * Acknowledgement means requested, not healthy or completed. Never retry an ambiguous error.
   */
  submit(
    expectedRevision: string,
    beforeSubmit: () => Promise<void>,
    idempotencyKey?: string,
    channel?: "stable" | "preview",
  ): Promise<void>;
}
