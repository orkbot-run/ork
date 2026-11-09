// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Shared framed response consumption is an Ork addition.

import type { AuthCapabilities } from "@orkbot/contracts";
import {
  authCapabilitiesSchema,
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_VERSION,
  legacyAuthCapabilitiesSchema,
  supportsProtocolVersion,
} from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";

export type { AuthCapabilities } from "@orkbot/contracts";

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

let capabilitiesRequest: Promise<AuthCapabilities> | undefined;

export class ProtocolUpdateRequired extends Error {
  constructor(readonly capabilities: AuthCapabilities) {
    super("Could not load authentication capabilities");
  }
}

/** Authentication remains available on the stable recovery surface. */
export const fetchRecoveryCapabilities = () => loadAuthCapabilities(true);
export const resetAuthCapabilities = () => {
  capabilitiesRequest = undefined;
};

export function fetchAuthCapabilities(): Promise<AuthCapabilities> {
  // Auth can briefly remount during session refresh; the gate uses the same deployment lookup.
  capabilitiesRequest ??= loadAuthCapabilities().then(
    (capabilities) => {
      if (capabilities.sso && capabilities.sso.availability !== "available") {
        capabilitiesRequest = undefined;
      }
      return capabilities;
    },
    (error: unknown) => {
      capabilitiesRequest = undefined;
      throw error;
    },
  );
  return capabilitiesRequest;
}

/** Public deployment capabilities, bounded in time and size so a stalled API cannot hang the UI. */
async function loadAuthCapabilities(recovery = false): Promise<AuthCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/capabilities", {
      signal: controller.signal,
      headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) },
    });
    if (!response.ok) throw new Error("Could not load authentication capabilities");
    const body = await readBoundedJsonResponse<unknown>(
      response,
      MAX_RESPONSE_BYTES,
      controller.signal,
      { nativeFramed: true },
    );
    const capabilities = authCapabilitiesSchema.or(legacyAuthCapabilitiesSchema).parse(body);
    if (!recovery && !supportsProtocolVersion(capabilities.protocol))
      throw new ProtocolUpdateRequired(capabilities);
    return capabilities;
  } finally {
    clearTimeout(timer);
  }
}
