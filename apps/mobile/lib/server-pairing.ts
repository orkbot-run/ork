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

const ISSUER = "https://api.ork.run";
const ENDPOINT = `${ISSUER}/api/server-pairings`;
const ID = /^[a-f0-9]{64}$/;

export interface MobileServerPairing {
  ticket: ServerPairing;
  state(signal?: AbortSignal): Promise<ServerPairingState>;
  approve(origin: string, signal?: AbortSignal): Promise<ServerPairingState>;
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
  expectedOwner: string,
  signal?: AbortSignal,
): Promise<MobileServerPairing> {
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
  const value = await request("POST", "", originalAccessToken, {}, signal);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    !ID.test(item.id) ||
    typeof item.code !== "string" ||
    normalizeServerPairingCode(item.code) !== item.code ||
    typeof item.expiresAt !== "number" ||
    !Number.isSafeInteger(item.expiresAt) ||
    item.expiresAt <= Date.now() / 1000 ||
    item.expiresAt > Date.now() / 1000 + SERVER_PAIRING_LIFETIME_SECONDS + 30
  )
    throw failed();
  const ticket: ServerPairing = {
    id: item.id,
    code: item.code,
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
  let claimedOrigin: string | null = null;
  let approvedOrigin: string | null = null;
  let approvalRequested = false;
  function validateState(value: unknown): ServerPairingState {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw failed();
    const item = value as Record<string, unknown>;
    const status = item.status;
    if (
      item.expiresAt !== ticket.expiresAt ||
      (status !== "pending" &&
        status !== "approval-required" &&
        status !== "approved" &&
        status !== "ready" &&
        status !== "failed" &&
        status !== "expired")
    )
      throw failed();
    const origin = item.origin;
    if (origin !== null) {
      if (typeof origin !== "string") throw failed();
      const parsed = normalizeApiBase(origin);
      if (!parsed.ok || parsed.url !== origin || isLoopbackHost(new URL(origin).hostname))
        throw failed();
      if (claimedOrigin !== null && origin !== claimedOrigin) throw failed();
    }
    if (
      (status === "pending" && origin !== null) ||
      (status !== "pending" && status !== "failed" && status !== "expired" && origin === null) ||
      (claimedOrigin !== null && origin !== claimedOrigin)
    )
      throw failed();
    if (origin !== null) claimedOrigin = origin;
    approvalRequested = status === "approval-required";
    return { status, origin, expiresAt: ticket.expiresAt };
  }
  return {
    ticket,
    cancel,
    async approve(origin, approvalSignal) {
      if (
        cancelled ||
        !approvalRequested ||
        origin !== claimedOrigin ||
        approvedOrigin !== null ||
        ticket.expiresAt <= Date.now() / 1000
      )
        throw failed();
      const current = await authorize();
      const result = await request(
        "POST",
        `/${ticket.id}/approve`,
        current.accessToken,
        { origin },
        approvalSignal,
      );
      await authorize();
      if (approvalSignal?.aborted || cancelled) throw failed();
      const state = validateState(result);
      if (state.status !== "approved" || state.origin !== origin) throw failed();
      approvedOrigin = origin;
      return state;
    },
    async state(statusSignal) {
      if (cancelled) throw failed();
      const current = await authorize();
      if (ticket.expiresAt <= Date.now() / 1000)
        return { status: "expired", origin: claimedOrigin, expiresAt: ticket.expiresAt };
      const result = await request(
        "GET",
        `/${ticket.id}`,
        current.accessToken,
        undefined,
        statusSignal,
      );
      await authorize();
      if (statusSignal?.aborted || cancelled) throw failed();
      const state = validateState(result);
      if (
        (state.status === "approved" || state.status === "ready") &&
        (approvedOrigin === null || state.origin !== approvedOrigin)
      )
        throw failed();
      return state;
    },
  };
}
