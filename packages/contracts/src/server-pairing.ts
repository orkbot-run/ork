// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

export const SERVER_PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const SERVER_PAIRING_LIFETIME_SECONDS = 300;
export const SERVER_PAIRING_PURPOSE = "orkbot-server-pairing-v1";

export interface ServerPairing {
  id: string;
  code: string;
  /** Unix seconds, issued by Accounts. */
  expiresAt: number;
}

export type ServerPairingStatus =
  | "pending"
  | "approval-required"
  | "approved"
  | "ready"
  | "failed"
  | "expired";

export interface ServerPairingState {
  status: ServerPairingStatus;
  origin: string | null;
  /** Unix seconds, issued by Accounts. */
  expiresAt: number;
}

/** Display grouping is cosmetic; the wire always carries six unambiguous ASCII symbols. */
export function normalizeServerPairingCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 16 || /[^a-zA-Z2-9\s-]/.test(value)) return null;
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[2-9A-HJ-NP-Z]{6}$/.test(code) ? code : null;
}
