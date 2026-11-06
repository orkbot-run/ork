// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerPairing, ServerPairingState } from "@orkbot/contracts";
import {
  isLoopbackHost,
  normalizeServerPairingCode,
  SERVER_PAIRING_LIFETIME_SECONDS,
} from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";
import { accountsAuthorization, accountsVersion } from "./accounts";
import { normalizeApiBase } from "./endpoint";
import { t } from "./i18n";

const ISSUER = "https://api.orkbot.run";
const ENDPOINT = `${ISSUER}/api/server-pairings`;
const ID = /^[a-f0-9]{64}$/;

export interface MobileServerPairing {
  ticket: ServerPairing;
  state(signal?: AbortSignal): Promise<ServerPairingState>;
  cancel(): Promise<void>;
}

const failed = () => new Error(t("Could not pair this server. Try again."));
const changed = () => new Error(t("Sign in to Accounts to continue."));

async function request(
  method: "POST" | "GET" | "DELETE",
  path: string,
  accessToken: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${ENDPOINT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401) throw changed();
      if (response.status === 429) throw new Error(t("Too many attempts. Try again later."));
      throw failed();
    }
    return response.status === 204
      ? undefined
      : await readBoundedJsonResponse<unknown>(response, 16 * 1024, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** The short code stays in memory; only Accounts receives its own native bearer. */
export async function beginServerPairing(
  input: string,
  expectedOwner: string,
  signal?: AbortSignal,
): Promise<MobileServerPairing> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) throw new Error(parsed.error);
  if (isLoopbackHost(new URL(parsed.url).hostname))
    throw new Error(t("Use a self-hosted server address."));
  const origin = parsed.url;
  const version = accountsVersion();
  const authorize = async () => {
    const value = await accountsAuthorization();
    if (
      signal?.aborted ||
      version !== accountsVersion() ||
      value?.issuer !== ISSUER ||
      JSON.stringify([value.issuer, value.subject]) !== expectedOwner
    )
      throw changed();
    return value;
  };
  const authorization = await authorize();
  const originalAccessToken = authorization.accessToken;
  const value = await request("POST", "", originalAccessToken, { origin }, signal);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !ID.test(item.id) ||
    typeof item.code !== "string" ||
    normalizeServerPairingCode(item.code) !== item.code ||
    item.origin !== origin ||
    typeof item.expiresAt !== "number" ||
    !Number.isSafeInteger(item.expiresAt) ||
    item.expiresAt <= Date.now() / 1000 ||
    item.expiresAt > Date.now() / 1000 + SERVER_PAIRING_LIFETIME_SECONDS + 30
  )
    throw failed();
  const ticket: ServerPairing = {
    id: item.id,
    code: item.code,
    origin,
    expiresAt: item.expiresAt,
  };
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    // A late cancellation owns only the previous record and immutable credential.
    await request("DELETE", `/${ticket.id}`, originalAccessToken);
  };
  try {
    await authorize();
  } catch (error) {
    void cancel().catch(() => undefined);
    throw error;
  }
  return {
    ticket,
    cancel,
    async state(statusSignal) {
      if (cancelled) throw failed();
      const current = await authorize();
      if (ticket.expiresAt <= Date.now() / 1000)
        return { status: "expired", origin, expiresAt: ticket.expiresAt };
      const result = await request(
        "GET",
        `/${ticket.id}`,
        current.accessToken,
        undefined,
        statusSignal,
      );
      await authorize();
      if (
        statusSignal?.aborted ||
        cancelled ||
        !result ||
        typeof result !== "object" ||
        Array.isArray(result)
      )
        throw failed();
      const state = result as Record<string, unknown>;
      if (
        state.origin !== origin ||
        state.expiresAt !== ticket.expiresAt ||
        !["pending", "ready", "failed", "expired"].includes(String(state.status))
      )
        throw failed();
      return state as unknown as ServerPairingState;
    },
  };
}
