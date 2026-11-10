// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isLoopbackHost } from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";
import { accountsAuthorization, accountsVersion } from "./accounts";
import { normalizeApiBase } from "./endpoint";

const DIRECTORY = "https://api.orkbot.run/api/servers";

export type AccountServer = {
  id: string;
  url: string;
  kind: "selfhosted";
  deviceId: null;
  name?: string;
};

function server(value: unknown): AccountServer {
  if (!value || typeof value !== "object") throw new Error("Could not load your servers.");
  const item = value as Record<string, unknown>;
  const parsed = typeof item.url === "string" ? normalizeApiBase(item.url) : null;
  if (
    typeof item.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) ||
    !parsed?.ok ||
    parsed.url !== item.url ||
    isLoopbackHost(new URL(parsed.url).hostname) ||
    item.kind !== "selfhosted" ||
    item.deviceId != null
  )
    throw new Error("Could not load your servers.");
  return { id: item.id, url: parsed.url, kind: "selfhosted", deviceId: null };
}

async function request(
  method: "GET" | "POST",
  body?: unknown,
  expectedOwner?: string,
  workspace = false,
) {
  const version = accountsVersion();
  const authorization = await accountsAuthorization();
  if (
    authorization?.issuer !== "https://api.orkbot.run" ||
    version !== accountsVersion() ||
    (expectedOwner &&
      expectedOwner !== JSON.stringify([authorization.issuer, authorization.subject]))
  )
    throw new Error("Sign in to Accounts to continue.");
  const response = await fetch(workspace ? `${DIRECTORY}/workspaces` : DIRECTORY, {
    method,
    headers: {
      authorization: `Bearer ${authorization.accessToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Could not update your servers. Try again.");
  return readBoundedJsonResponse<unknown>(response, 64 * 1024);
}

export async function accountServers(expectedOwner?: string): Promise<AccountServer[]> {
  const result = await request("GET", undefined, expectedOwner, true);
  if (
    !result ||
    typeof result !== "object" ||
    !("workspaces" in result) ||
    !Array.isArray(result.workspaces)
  )
    throw new Error("Could not load your servers.");
  return result.workspaces.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string")
      throw new Error("Could not load your servers.");
    return { ...server({ ...item, kind: "selfhosted", deviceId: null }), name: item.name };
  });
}

export async function addAccountServer(
  url: string,
  expectedOwner?: string,
): Promise<AccountServer> {
  const parsed = normalizeApiBase(url);
  if (!parsed.ok) throw new Error(parsed.error);
  if (isLoopbackHost(new URL(parsed.url).hostname))
    throw new Error("Use a self-hosted server address.");
  const result = await request("POST", { url: parsed.url, kind: "selfhosted" }, expectedOwner);
  if (!result || typeof result !== "object" || !("server" in result))
    throw new Error("Could not save your server.");
  const saved = server(result.server);
  if (saved.url !== parsed.url) throw new Error("Accounts returned a different server.");
  return saved;
}
