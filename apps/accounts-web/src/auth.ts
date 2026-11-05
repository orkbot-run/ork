// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// Relative requests keep account cookies on the central login origin.
// The OAuth plugin preserves the provider's signed authorization continuation.
export const ACCOUNT_PATH = "/account";
export const auth = createAuthClient({
  basePath: `${ACCOUNT_PATH}/api/auth`,
  plugins: [oauthProviderClient()],
});

/** Signed login requests expire even before a password has been submitted. */
export function authorizationExpired(search: string, now = Date.now()) {
  const query = new URLSearchParams(search);
  if (!query.has("client_id") || !query.has("sig")) return false;
  const expiresAt = Number(query.get("exp"));
  return !Number.isFinite(expiresAt) || expiresAt * 1000 <= now;
}

export function accountLink(path: string) {
  const query = new URLSearchParams(window.location.search);
  // Reset tokens and result messages must not follow ordinary navigation links.
  for (const key of ["token", "error", "verified"]) query.delete(key);
  return ACCOUNT_PATH + path + (query.size ? `?${query}` : "");
}

export function authError(error: { status?: number; code?: string; error?: string } | null) {
  if (!error) return null;
  if (error.error === "invalid_signature")
    return "This sign-in request is invalid or expired. Start again.";
  if (error.status === 429) return "Too many attempts. Please try again later.";
  if (error.code === "EMAIL_NOT_VERIFIED") return "Verify your email before signing in.";
  return "Unable to continue. Check your details and try again.";
}
