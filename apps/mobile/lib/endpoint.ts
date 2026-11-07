// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 endpoint validation is preserved. Accounts-only server checks are Ork additions.

import {
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_VERSION,
  isPrivateNetworkHost,
  protocolRangeSchema,
} from "@orkbot/contracts";
import { cancelResponseBody, readBoundedJsonResponse, withAbort } from "@orkbot/core";
import { t } from "./i18n";
import { DEFAULT_API, LOCAL_API } from "./server-config";

export const API_PROBE_TIMEOUT_MS = 8_000;
export const MAX_API_PROBE_RESPONSE_BYTES = 64 * 1024;

/** The app never falls back to an older server's local credential forms. */
export async function requireAccountsSignIn(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ accountsLogin: boolean }> {
  const parsed = normalizeApiBase(url);
  if (!parsed.ok || parsed.url !== url) throw new Error("Invalid server address.");
  const signal = AbortSignal.timeout(API_PROBE_TIMEOUT_MS);
  const response = await withAbort(
    fetch(`${url}/api/auth/capabilities`, {
      headers,
      credentials: "omit",
      redirect: "error",
      signal,
    }),
    signal,
  );
  if (!response.ok) throw new Error("Could not read the server's sign-in options.");
  const value = await readBoundedJsonResponse<unknown>(
    response,
    MAX_API_PROBE_RESPONSE_BYTES,
    signal,
  );
  requireSupportedProtocol(value);
  if (
    value &&
    typeof value === "object" &&
    "passwordAuth" in value &&
    value.passwordAuth === false &&
    "accountsLogin" in value &&
    value.accountsLogin === true
  )
    return { accountsLogin: true };
  if (
    !value ||
    typeof value !== "object" ||
    !("passwordAuth" in value) ||
    value.passwordAuth !== false ||
    !("sso" in value) ||
    !value.sso ||
    typeof value.sso !== "object" ||
    !("name" in value.sso) ||
    typeof value.sso.name !== "string" ||
    !value.sso.name.trim() ||
    !("availability" in value.sso) ||
    value.sso.availability !== "available"
  )
    throw new Error("This server must use Accounts sign-in.");
  return { accountsLogin: false };
}

/** Discovery describes wire compatibility, independently of the app's release timestamp. */
export function requireSupportedProtocol(value: unknown): void {
  if (!value || typeof value !== "object" || !("protocol" in value)) return;
  const parsed = protocolRangeSchema.safeParse(value.protocol);
  if (!parsed.success) throw new Error(t("Could not load sign-in options"));
  if (parsed.data.min > CLIENT_PROTOCOL_VERSION)
    throw new Error(t("Update Ork to connect to this server."));
  if (parsed.data.max < CLIENT_PROTOCOL_VERSION)
    throw new Error(t("Update this server before connecting with this version of Ork."));
}

/** Read initialization state without sending Accounts or product credentials. */
export async function serverInitializationRequired(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  const parsed = normalizeApiBase(url);
  const failure = () => new Error(t("Could not pair this server. Try again."));
  if (!parsed.ok || parsed.url !== url) throw failure();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, API_PROBE_TIMEOUT_MS);
  try {
    const response = await withAbort(
      fetchImpl(`${url}/api/auth/native/initialization`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (response.status === 404) {
      cancelResponseBody(response);
      return false;
    }
    if (!response.ok) {
      cancelResponseBody(response);
      throw failure();
    }
    const value = await readBoundedJsonResponse<unknown>(
      response,
      MAX_API_PROBE_RESPONSE_BYTES,
      controller.signal,
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("required" in value) ||
      typeof value.required !== "boolean"
    )
      throw failure();
    return value.required;
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export type EndpointResult = { ok: true; url: string } | { ok: false; error: string };
type HealthResponse = { json?: { ok?: boolean }; error?: { message?: string } };

export function defaultApiBase() {
  return originOnly(DEFAULT_API) ?? LOCAL_API;
}

export function normalizeApiBase(input: string): EndpointResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: t("Enter a server URL") };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: t("That doesn’t look like a URL") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: t("Use an http or https URL") };
  }
  if (!parsed.hostname) return { ok: false, error: t("That URL is missing a host") };
  if (parsed.protocol === "http:" && !isPrivateNetworkHost(parsed.hostname)) {
    return { ok: false, error: "Public servers need https://" };
  }
  const url = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url };
}

export function displayApiHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function usesCustomApiBase(url: string, fallback = defaultApiBase()) {
  return url !== fallback;
}

export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !isPrivateNetworkHost(parsed.hostname)) {
      return t("Public servers need https://. HTTP only works on your local network.");
    }
  } catch {
    return null;
  }
  return null;
}

export async function probeApiBase(
  input: string,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_PROBE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetchImpl(`${parsed.url}/rpc/health`, {
        method: "POST",
        ...(Object.keys(headers).length ? { redirect: "error" as const } : {}),
        headers: {
          ...headers,
          [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
          "content-type": "application/json",
          origin: "orkbot://",
        },
        body: JSON.stringify({ json: {} }),
        signal: controller.signal,
      }),
      controller.signal,
      "Request timed out",
    );
    if (!res.ok) {
      cancelResponseBody(res);
      return { ok: false, error: t("That URL did not look like a Ork server") };
    }
    let body: HealthResponse;
    try {
      body = await readBoundedJsonResponse<HealthResponse>(
        res,
        MAX_API_PROBE_RESPONSE_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      body = {};
    }
    if (body.error || body.json?.ok !== true) {
      return { ok: false, error: t("That URL did not look like a Ork server") };
    }
    return parsed;
  } catch {
    return { ok: false, error: t("Could not reach that server") };
  } finally {
    clearTimeout(timer);
  }
}

function originOnly(value: string) {
  const parsed = normalizeApiBase(value);
  return parsed.ok ? parsed.url : null;
}
