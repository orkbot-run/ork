// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  IdentityCatalog,
  InstallationDirectRoute,
  InstallationRelayRoute,
  WorkspaceTarget,
} from "@orkbot/contracts";
import {
  catalogWorkspace,
  identityCatalogSchema,
  installationDirectRouteSchema,
  installationRelayRouteSchema,
  installationVirtualOrigin,
  isLoopbackHost,
} from "@orkbot/contracts";
import { readBoundedJsonResponse } from "@orkbot/core";
import { accountsAuthorization, accountsConfiguration, accountsVersion } from "./accounts";
import { fetchAccounts } from "./accounts-network";
import { normalizeApiBase } from "./endpoint";

export type AccountServer = {
  id: string;
  url: string;
  kind: "selfhosted";
  deviceId: null;
  name?: string;
  organizationName?: string;
  serverName?: string;
  workspace?: WorkspaceTarget;
  relay?: InstallationRelayRoute;
  direct?: InstallationDirectRoute;
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
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  expectedOwner?: string,
  path: "servers" | "identity/v2/catalog" | "organizations/preferences" = "servers",
) {
  const version = accountsVersion();
  const authorization = await accountsAuthorization();
  const configuration = await accountsConfiguration();
  if (
    authorization?.issuer !== configuration.issuer ||
    version !== accountsVersion() ||
    (expectedOwner &&
      expectedOwner !== JSON.stringify([authorization.issuer, authorization.subject]))
  )
    throw new Error("Sign in to Accounts to continue.");
  const response = await fetchAccounts(`${configuration.issuer}/api/${path}`, {
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
  const value = await readBoundedJsonResponse<unknown>(
    response,
    path === "identity/v2/catalog" ? 4 * 1024 * 1024 : 64 * 1024,
  );
  if (version !== accountsVersion()) throw new Error("Sign in to Accounts to continue.");
  return value;
}

export async function accountDirectory(
  expectedOwner?: string,
): Promise<{ catalog: IdentityCatalog; entries: AccountServer[] }> {
  const value = await request("GET", undefined, expectedOwner, "identity/v2/catalog");
  const parsed = identityCatalogSchema.safeParse(value);
  if (!parsed.success) throw new Error("Could not load your servers.");
  const catalog = parsed.data;
  const entries: AccountServer[] = [];
  for (const organization of catalog.organizations)
    for (const installation of organization.servers)
      for (const workspace of installation.workspaces) {
        const selected = catalogWorkspace(catalog, {
          organizationId: organization.id,
          serverId: installation.id,
          workspaceId: workspace.id,
        });
        if (!selected) continue;
        const route = installation.routes.find((row) => row.kind === "direct");
        const tunnel = installation.routes.find((row) => row.kind === "tunnel");
        if (!route && !tunnel) continue;
        const relay = tunnel
          ? installationRelayRouteSchema.parse({ origin: tunnel.address })
          : undefined;
        const direct = route
          ? installationDirectRouteSchema.parse({ origin: route.address })
          : undefined;
        const url = installationVirtualOrigin(installation.id);
        entries.push({
          ...server({ id: workspace.id, url, kind: "selfhosted", deviceId: null }),
          name: workspace.name,
          organizationName: organization.name,
          serverName: installation.name,
          workspace: selected.target,
          ...(relay ? { relay } : {}),
          ...(direct ? { direct } : {}),
        });
      }
  return { catalog, entries };
}

export async function accountServers(expectedOwner?: string): Promise<AccountServer[]> {
  return (await accountDirectory(expectedOwner)).entries;
}

export async function setDefaultAccountOrganization(
  organizationId: string | null,
  expectedOwner: string,
): Promise<void> {
  const schema = identityCatalogSchema.pick({ defaultOrganizationId: true });
  const input = schema.parse({ defaultOrganizationId: organizationId });
  const result = schema.parse(
    await request("PATCH", input, expectedOwner, "organizations/preferences"),
  );
  if (result.defaultOrganizationId !== organizationId)
    throw new Error("Could not save the organization preference.");
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
