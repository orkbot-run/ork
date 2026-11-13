// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  accountDirectory,
  accountServers,
  addAccountServer,
  setDefaultAccountOrganization,
} from "./account-servers";
import { accountsAuthorization } from "./accounts";

vi.mock("./accounts", () => ({
  accountsAuthorization: vi.fn(),
  accountsVersion: () => 0,
  accountsConfiguration: async () => ({
    issuer: "https://api.ork.run",
    clientId: "fixture-client",
  }),
}));
vi.mock("./i18n", () => ({ t: (value: string) => value }));
const remote = {
  id: "00000000-0000-4000-8000-000000000001",
  url: "https://server.example.test",
  kind: "selfhosted",
  deviceId: null,
};
beforeEach(() => {
  vi.mocked(accountsAuthorization).mockResolvedValue({
    issuer: "https://api.ork.run",
    subject: "subject-a",
    accessToken: "central-bearer",
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["direct", "tunnel"] as const)(
  "opens a %s workspace while keeping the central bearer on Accounts",
  async (kind) => {
    const organizationId = "00000000-0000-4000-8000-000000000002";
    const serverId = "00000000-0000-4000-8000-000000000003";
    const routeId = "00000000-0000-4000-8000-000000000004";
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        version: 2,
        defaultOrganizationId: organizationId,
        organizations: [
          {
            id: organizationId,
            name: "Company",
            type: "shared",
            role: "member",
            servers: [
              {
                id: serverId,
                name: "Server",
                state: "ready",
                bindingVersion: 1,
                keyFingerprint: "a".repeat(64),
                routes: [
                  {
                    id: routeId,
                    kind,
                    address: kind === "direct" ? remote.url : "https://relay.example.test",
                    deviceId: null,
                  },
                ],
                workspaces: [
                  { id: remote.id, name: "Team", state: "ready", canOpen: true, role: "member" },
                ],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await accountServers()).toEqual([
      {
        ...remote,
        ...(kind === "tunnel"
          ? {
              url: `https://${serverId}.installation.ork.invalid`,
              relay: { origin: "https://relay.example.test" },
            }
          : {}),
        name: "Team",
        organizationName: "Company",
        serverName: "Server",
        workspace: {
          organizationId,
          serverId,
          workspaceId: remote.id,
          bindingVersion: 1,
          keyFingerprint: "a".repeat(64),
        },
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.ork.run/api/identity/v2/catalog",
      expect.objectContaining({
        headers: { authorization: "Bearer central-bearer" },
        credentials: "omit",
        redirect: "error",
      }),
    );
  },
);
it("never accepts a local computer as a workspace server", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        workspaces: [
          {
            id: "desktop",
            url: "http://127.0.0.1:45173",
            name: "Desktop",
          },
        ],
      }),
    ),
  );
  await expect(accountServers()).rejects.toThrow("Could not load your servers");
});
it("does not contact any endpoint without an Accounts session", async () => {
  vi.mocked(accountsAuthorization).mockResolvedValue(null);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(accountServers()).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not send a different issuer's credential to the central directory", async () => {
  vi.mocked(accountsAuthorization).mockResolvedValue({
    issuer: "https://other.example.test",
    subject: "subject-a",
    accessToken: "private-other-token",
  });
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(accountServers()).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not perform a stale account's directory mutation with the new account's token", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    addAccountServer(remote.url, JSON.stringify(["https://api.ork.run", "old-subject"])),
  ).rejects.toThrow("Sign in to Accounts");
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects a saved entry that substitutes a different product origin", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ server: { ...remote, url: "https://other.example.test" } }),
      ),
  );
  await expect(addAccountServer(remote.url)).rejects.toThrow("different server");
});

it.each(["http://127.0.0.1:45173", "http://localhost:45173", "http://[::1]:45173"])(
  "does not synchronize this device's loopback URL %s",
  async (url) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(addAccountServer(url)).rejects.toThrow("self-hosted server address");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it("stores a normalized bookmark without contacting the proposed product server", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ server: remote }));
  vi.stubGlobal("fetch", fetcher);
  expect(await addAccountServer("server.example.test/path?token=discarded")).toEqual(remote);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.ork.run/api/servers",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ url: remote.url, kind: "selfhosted" }),
    }),
  );
});
it.each([
  {
    workspaces: [{ ...remote, name: "Team", url: "https://user:secret@server.example.test/path" }],
  },
  { workspaces: "invalid" },
])("rejects malformed directory response %j", async (response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
  await expect(accountServers()).rejects.toThrow("Could not load your servers");
});

it("retains organizations without servers instead of hiding them behind a flat list", async () => {
  const catalog = {
    version: 2,
    defaultOrganizationId: null,
    organizations: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Personal",
        type: "personal",
        role: "admin",
        servers: [],
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(catalog)),
  );
  expect(await accountDirectory()).toEqual({ catalog, entries: [] });
});

it("saves the shared default through Accounts while leaving workspace history on the device", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000002";
  const fetcher = vi.fn(async () => Response.json({ defaultOrganizationId: organizationId }));
  vi.stubGlobal("fetch", fetcher);
  await setDefaultAccountOrganization(
    organizationId,
    JSON.stringify(["https://api.ork.run", "subject-a"]),
  );
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.ork.run/api/organizations/preferences",
    expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ defaultOrganizationId: organizationId }),
      headers: { authorization: "Bearer central-bearer", "content-type": "application/json" },
      redirect: "error",
      credentials: "omit",
    }),
  );
});
