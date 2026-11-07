// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited auth contracts are preserved; native account proof is an Ork addition.

import { z } from "zod";
import { protocolRangeSchema } from "./client-protocol.js";

export const authCapabilitiesSchema = z.object({
  /** Supported RPC versions; omitted by servers that speak the original protocol. */
  protocol: protocolRangeSchema.optional(),
  /** The AI disclosure procedures exist; each request still needs its own consent check. */
  aiConsent: z.boolean().optional(),
  /** Native Accounts proofs are exchanged for a server session, without server OIDC credentials. */
  accountsLogin: z.boolean().optional(),
  /** The server supplies browser handoff pages while the desktop carries its renderer. */
  nativeRenderer: z.literal("bundled-v1").optional(),
  sso: z
    .object({
      name: z.string().min(1),
      availability: z.enum(["available", "unavailable", "checking"]),
    })
    .nullable(),
  /** Returned only to native main with its private instance capability. */
  managedAccountKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  passwordAuth: z.boolean(),
  passwordReset: z.boolean(),
  resetUrl: z.string().url().nullable(),
  // Older servers omit this field; clients treat omission as unavailable.
  emailCode: z.boolean().optional(),
  billing: z.boolean().optional(),
  /** WebAuthn relying party ID; null or omitted when this server does not offer passkeys. */
  passkeyRpId: z.string().min(1).nullable().optional(),
  /** Native apps this domain vouches for; omitted by older servers, which means none. */
  nativePasskeys: z.object({ ios: z.boolean(), android: z.boolean() }).optional(),
});
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
  emailDeletion: z.boolean(),
  sso: z.object({ name: z.string().min(1) }).nullable(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** Only a complete pre-SSO shape may opt into password-only compatibility. */
export const legacyAuthCapabilitiesSchema = authCapabilitiesSchema
  .omit({ sso: true, passwordAuth: true })
  .strict()
  .transform((value) => ({ ...value, passwordAuth: true, sso: null }));

/** Pre-SSO servers only had credential accounts and password-protected deletion. */
export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: null,
};

/**
 * The RPC error code for a sensitive action the session must confirm its
 * identity for first. Clients confirm, then retry the action once.
 */
export const IDENTITY_CONFIRMATION_REQUIRED = "IDENTITY_CONFIRMATION_REQUIRED";

export function isIdentityConfirmationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === IDENTITY_CONFIRMATION_REQUIRED
  );
}

/**
 * Runs an action that may need a recent identity confirmation. When the server asks for one,
 * `confirm` prompts; once confirmed, the action is retried a single time.
 * A dismissed prompt rethrows the server's error.
 */
export async function runWithIdentityConfirmation<T>(
  action: () => Promise<T>,
  confirm: () => Promise<boolean>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isIdentityConfirmationRequired(error) || !(await confirm())) throw error;
  }
  return action();
}
