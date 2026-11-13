// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { relayAdmissionSchema } from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";

/** Only short relay capabilities leave this service; it has no account or product bearer. */
export function accountsRedeemer(issuer: string, origin: string, request: typeof fetch = fetch) {
  for (const value of [issuer, origin]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password)
      throw new Error("Relay endpoints must be HTTPS origins");
  }
  if (issuer === origin) throw new Error("Relay and Accounts must have separate origins");
  return async (ticket: string, signal: AbortSignal) => {
    const response = await request(`${issuer}/api/identity/v2/relay-tickets/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
      signal,
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Relay admission refused");
    }
    const admission = relayAdmissionSchema.parse(
      await readBoundedJsonResponse(response, 8 * 1024, signal),
    );
    if (admission.relayOrigin !== origin) throw new Error("Relay admission refused");
    return admission;
  };
}
