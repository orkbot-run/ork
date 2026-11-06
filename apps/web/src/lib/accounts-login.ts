// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readBoundedJsonResponse } from "@orkbot/core";
import { desktopBridge } from "./desktop";

async function request(path: string, body: unknown): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(15_000);
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  const value = await readBoundedJsonResponse<unknown>(response, 64 * 1024, signal);
  if (!response.ok || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Could not continue");
  return value as Record<string, unknown>;
}

/** Exchange an audience-bound native proof; the Accounts bearer never enters the renderer. */
export async function signInWithNativeAccounts(): Promise<void> {
  const accounts = desktopBridge()?.accounts;
  if (!accounts?.createServerLoginGrant) throw new Error("Could not continue");
  const origin = window.location.origin;
  const challenge = await request("/api/auth/native/challenge", {});
  if (
    typeof challenge.challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge.challenge) ||
    typeof challenge.expiresAt !== "number" ||
    challenge.expiresAt <= Date.now() / 1000 ||
    typeof challenge.bootstrapRequired !== "boolean"
  )
    throw new Error("Could not continue");
  const bootstrapSecret = challenge.bootstrapRequired
    ? await accounts.consumeServerInitializationSecret?.()
    : undefined;
  if (challenge.bootstrapRequired && !bootstrapSecret) throw new Error("REGISTRATION_CLOSED");
  const { grant, expiresAt } = await accounts.createServerLoginGrant({
    origin,
    challenge: challenge.challenge,
  });
  if (
    window.location.origin !== origin ||
    typeof grant !== "string" ||
    grant.length > 64 * 1024 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() / 1000
  )
    throw new Error("Could not continue");
  const complete = await request("/api/auth/native/complete", {
    challenge: challenge.challenge,
    grant,
    ...(bootstrapSecret ? { bootstrapSecret } : {}),
  });
  if (
    !complete.user ||
    typeof complete.user !== "object" ||
    !("id" in complete.user) ||
    typeof complete.user.id !== "string"
  )
    throw new Error("Could not continue");
}
