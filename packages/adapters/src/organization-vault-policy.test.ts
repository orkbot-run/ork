// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { runAsTenant } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { organizationVaultPolicy } from "./organization-vault-policy.js";

function fixture() {
  const binding = {
    id: "workspace",
    spaceId: "space",
    localOrganizationId: "org",
    organizationType: "shared",
    centralOrganizationId: "central",
    serverId: "server",
    bindingVersion: 2,
    state: "ready",
    validUntil: new Date(Date.now() + 60_000),
  };
  const installation = {
    state: "ready",
    serverId: "server",
    centralOrganizationId: "central",
    localOrganizationId: "org",
    bindingVersion: 2,
  };
  const grant = { spaceId: "space", organizationId: "org", bindingVersion: 2 };
  const prisma = {
    space: { findUnique: vi.fn().mockResolvedValue({ centralBinding: binding }) },
    centralWorkspaceAccess: { findUnique: vi.fn().mockResolvedValue({ active: true }) },
    installationIdentity: { findUnique: vi.fn().mockResolvedValue(installation) },
    organizationVaultGrant: { findUnique: vi.fn().mockResolvedValue(grant) },
  };
  return { prisma: prisma as never, binding, installation, grant };
}

const actor = { spaceId: "space", userId: "user" };

describe("organization vault policy", () => {
  it("grants only a current installation and workspace assignment", async () => {
    const f = fixture();
    await expect(
      runAsTenant(actor, () => organizationVaultPolicy(f.prisma, actor)),
    ).resolves.toMatchObject({ kind: "shared", granted: true });
    f.grant.bindingVersion++;
    await expect(
      runAsTenant(actor, () => organizationVaultPolicy(f.prisma, actor)),
    ).resolves.toMatchObject({ kind: "shared", granted: false });
    f.installation.bindingVersion++;
    await expect(
      runAsTenant(actor, () => organizationVaultPolicy(f.prisma, actor)),
    ).rejects.toThrow("Workspace access denied");
  });

  it("fails closed for an unknown organization type and allows the signed Personal exception", async () => {
    const f = fixture();
    f.binding.organizationType = "";
    await expect(organizationVaultPolicy(f.prisma, actor)).resolves.toEqual({ kind: "unverified" });
    f.binding.organizationType = "personal";
    await expect(organizationVaultPolicy(f.prisma, actor)).resolves.toEqual({ kind: "personal" });
  });

  it("does not let one tenant request another tenant's vault", async () => {
    const f = fixture();
    await expect(
      runAsTenant({ ...actor, userId: "other" }, () => organizationVaultPolicy(f.prisma, actor)),
    ).rejects.toThrow("Workspace access denied");
  });
});
