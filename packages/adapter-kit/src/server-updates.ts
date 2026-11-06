// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Redeploy the operator-configured channel; this does not select an immutable target. */
export interface ServerUpdateAdapter {
  readonly channel: "stable" | "preview";
  check(): Promise<{ revision: string; version: string } | null>;
  /** Acknowledgement means requested, not healthy or completed. Never retry an ambiguous error. */
  submit(expectedRevision: string): Promise<void>;
}
