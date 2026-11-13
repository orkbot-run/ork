// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { accountsConfig, createAccountsDiscovery } from "@orkbot/contracts/accounts";
import type { PendingWorkspaceRevocation } from "@orkbot/core";
import {
  cancelResponseBody,
  createPendingRevocations,
  readBoundedJsonResponse,
  withAbort,
} from "@orkbot/core";
import * as SecureStore from "expo-secure-store";
import { fetchInstallationRevocation } from "./installation-transport";

const STORAGE_KEY = "orkbot.pending-revocations";
const discover = createAccountsDiscovery();

const pending = createPendingRevocations({
  read: () => SecureStore.getItemAsync(STORAGE_KEY),
  write: (value) =>
    SecureStore.setItemAsync(STORAGE_KEY, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  async send(entry) {
    const signal = AbortSignal.timeout(8_000);
    let endpoint = `${entry.origin}/api/auth/sign-out`;
    let headers: Record<string, string> = {
      ...entry.headers,
      "content-type": "application/json",
      origin: "orkbot://",
      authorization: `Bearer ${entry.token}`,
    };
    let body = "{}";
    if (entry.kind === "oauth") {
      const metadata = await withAbort(
        discover(accountsConfig({ issuer: entry.origin, clientId: entry.clientId })),
        signal,
      );
      if (!metadata.revocation_endpoint) return true;
      endpoint = metadata.revocation_endpoint;
      headers = { "content-type": "application/x-www-form-urlencoded" };
      body = new URLSearchParams({
        client_id: entry.clientId!,
        token: entry.token,
        token_type_hint: entry.tokenType!,
      }).toString();
    }
    const init: RequestInit = {
      method: "POST",
      headers,
      body,
      credentials: "omit",
      redirect: "error",
      signal,
    };
    const response = await withAbort(
      entry.kind === "session"
        ? fetchInstallationRevocation(endpoint, init, entry.workspace)
        : fetch(endpoint, init),
      signal,
    );
    try {
      // A proxy can also return 401 or a login HTML page with 200.
      if (!response.ok) return false;
      if (entry.kind === "oauth") return true;
      const body = await readBoundedJsonResponse<unknown>(response, 8 * 1024, signal);
      return Boolean(
        body && typeof body === "object" && "success" in body && body.success === true,
      );
    } finally {
      cancelResponseBody(response);
    }
  },
});

export const queueSessionRevocation = (
  origin: string,
  token: string,
  headers: Record<string, string>,
  workspace?: PendingWorkspaceRevocation,
) =>
  pending.enqueue({ kind: "session", origin, token, headers, ...(workspace ? { workspace } : {}) });

export const queueAccountsRevocation = (
  origin: string,
  clientId: string,
  token: string,
  tokenType: "access_token" | "refresh_token",
) => pending.enqueue({ kind: "oauth", origin, clientId, token, tokenType });

/** Detached retries never affect the current sign-in or expose retained credentials. */
export function retryPendingRevocations(): Promise<void> {
  return pending.retry().catch(() => undefined);
}
