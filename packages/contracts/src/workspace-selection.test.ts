// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import type { IdentityCatalog } from "./identity.js";
import {
  catalogWorkspace,
  initialCatalogOrganization,
  initialCatalogWorkspace,
  parseWorkspaceLink,
} from "./workspace-selection.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const target = { organizationId: id(1), serverId: id(2), workspaceId: id(3) };
const fixture = (): IdentityCatalog => ({
  version: 2,
  defaultOrganizationId: null,
  organizations: [
    { id: id(4), name: "Personal", type: "personal", role: "admin", servers: [] },
    {
      id: id(1),
      name: "Company",
      type: "shared",
      role: "member",
      servers: [
        {
          id: id(2),
          name: "Server",
          bindingVersion: 7,
          keyFingerprint: "a".repeat(64),
          state: "ready",
          routes: [],
          workspaces: [
            { id: id(3), name: "Workspace", state: "ready", canOpen: true, role: "member" },
            { id: id(5), name: "Workspace", state: "ready", canOpen: false, role: null },
          ],
        },
      ],
    },
  ],
});

describe("shared organization and workspace selection", () => {
  it("uses the account default or the sole organization, preserving an empty organization", () => {
    const catalog = fixture();
    expect(initialCatalogOrganization(catalog)).toBeNull();
    catalog.defaultOrganizationId = id(1);
    catalog.organizations[1]!.servers = [];
    expect(initialCatalogOrganization(catalog)?.id).toBe(id(1));
    catalog.defaultOrganizationId = id(9);
    expect(initialCatalogOrganization(catalog)).toBeNull();
    catalog.organizations = [catalog.organizations[0]!];
    expect(initialCatalogOrganization(catalog)?.id).toBe(id(4));
  });
  it("restores an authorized workspace even when its server is unavailable", () => {
    const catalog = fixture();
    const server = catalog.organizations[1]!.servers[0]!;
    server.workspaces[1]!.canOpen = true;
    expect(initialCatalogWorkspace(catalog, id(1))).toBeNull();
    server.state = "disconnected";
    expect(
      initialCatalogWorkspace(catalog, id(1), { serverId: id(2), workspaceId: id(5) }),
    ).toEqual({ organizationId: id(1), serverId: id(2), workspaceId: id(5) });
    expect(catalogWorkspace(catalog, target)).toBeNull();
  });
  it("opens a sole authorized workspace and never chooses one from a different organization", () => {
    expect(initialCatalogWorkspace(fixture(), id(1))).toEqual(target);
    expect(initialCatalogWorkspace(fixture(), id(4), target)).toBeNull();
    const catalog = fixture();
    catalog.organizations[1]!.servers[0]!.workspaces[0]!.canOpen = false;
    expect(initialCatalogWorkspace(catalog, id(1))).toBeNull();
  });
  it("binds an accessible workspace to its exact installation identity and current version", () => {
    expect(catalogWorkspace(fixture(), target)?.target).toEqual({
      ...target,
      bindingVersion: 7,
      keyFingerprint: "a".repeat(64),
    });
  });
  it.each([
    { ...target, workspaceId: id(5) },
    { ...target, organizationId: id(4) },
    { ...target, serverId: id(9) },
  ])("never substitutes another accessible workspace for an unavailable target %j", (value) => {
    expect(catalogWorkspace(fixture(), value)).toBeNull();
  });
  it.each(["provisioning", "failed", "disabled"] as const)(
    "does not open a %s workspace",
    (state) => {
      const catalog = fixture();
      catalog.organizations[1]!.servers[0]!.workspaces[0]!.state = state;
      expect(catalogWorkspace(catalog, target)).toBeNull();
    },
  );
  it("parses identifier links without accepting an endpoint or duplicate selection", () => {
    const link = `orkbot://workspace?organization=${id(1)}&server=${id(2)}&workspace=${id(3)}`;
    expect(parseWorkspaceLink(link)).toEqual(target);
    for (const value of [
      `${link}&workspace=${id(5)}`,
      `${link}&url=https://attacker.example.test`,
      `${link}#fragment`,
      link.replace("orkbot:", "https:"),
      link.replace("workspace?", "workspace/other?"),
      link.replace(id(3), "invalid"),
    ])
      expect(parseWorkspaceLink(value)).toBeNull();
  });
});
