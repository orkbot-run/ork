// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 endpoint validation is preserved. Accounts-only server checks are Ork additions.

import { isPrivateNetworkHost } from "@orkbot/contracts";
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
  const response = await fetch(`${url}/api/auth/capabilities`, {
    headers,
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(API_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Could not read the server's sign-in options.");
  const value = await readBoundedJsonResponse<unknown>(response, MAX_API_PROBE_RESPONSE_BYTES);
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
        headers: { ...headers, "content-type": "application/json", origin: "orkbot://" },
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
