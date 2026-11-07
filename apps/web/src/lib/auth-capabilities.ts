import type { AuthCapabilities } from "@orkbot/contracts";
import {
  authCapabilitiesSchema,
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_VERSION,
  legacyAuthCapabilitiesSchema,
  supportsProtocolVersion,
} from "@orkbot/contracts";
import { ResponseBodyTooLargeError, readBoundedJsonResponse } from "@orkbot/core";

export type { AuthCapabilities } from "@orkbot/contracts";

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

let capabilitiesRequest: Promise<AuthCapabilities> | undefined;

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
async function loadAuthCapabilities(): Promise<AuthCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch("/api/auth/capabilities", {
      signal: controller.signal,
      headers: { [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION) },
    });
    if (!response.ok) throw new Error("Could not load authentication capabilities");
    const length = Number(response.headers.get("content-length") ?? Number.NaN);
    let body: unknown;
    if (
      response.type === "basic" &&
      !response.headers.has("content-encoding") &&
      Number.isSafeInteger(length) &&
      length >= 0 &&
      length <= MAX_RESPONSE_BYTES
    ) {
      // For an uncompressed same-origin fetch, HTTP framing bounds the body by Content-Length.
      // Native consumption avoids Chromium cancelling a completed manually read response stream.
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new ResponseBodyTooLargeError(MAX_RESPONSE_BYTES);
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } else {
      body = await readBoundedJsonResponse<unknown>(
        response,
        MAX_RESPONSE_BYTES,
        controller.signal,
      );
    }
    const capabilities = authCapabilitiesSchema.or(legacyAuthCapabilitiesSchema).parse(body);
    if (!supportsProtocolVersion(capabilities.protocol))
      throw new Error("Could not load authentication capabilities");
    return capabilities;
  } finally {
    clearTimeout(timer);
  }
}
