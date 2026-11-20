// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceProjection } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import type { InstallationClient } from "./installation-client.js";
import { WorkspaceAuthority } from "./workspace-authority.js";

const root = "10000000-0000-4000-8000-000000000001";
const peer = "10000000-0000-4000-8000-000000000002";
const revision = "20000000-0000-4000-8000-000000000001";
const anchor = {
  id: root,
  spaceId: "root-space",
  localOrganizationId: "org",
  centralOrganizationId: "central",
  serverId: "server",
  bindingVersion: 1,
};
const sibling = { ...anchor, id: peer, spaceId: "peer-space" };

function setup() {
  const spaces = new Map<string, typeof anchor>([
    ["root-space", anchor],
    ["peer-space", sibling],
  ]);
  const prisma = {
    space: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const binding = spaces.get(where.id);
        return binding
          ? { organizationId: "org", centralBinding: binding, admissionWorkspaceId: null }
          : null;
      }),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "member" })) },
    centralWorkspaceBinding: { findFirst: vi.fn() },
  } as unknown as PrismaClient;
  const authority = new WorkspaceAuthority(
    prisma,
    {} as InstallationClient,
    "https://accounts.example.test",
  );
  vi.spyOn(authority, "session").mockResolvedValue({
    spaceId: "root-space",
    workspaceId: root,
    subject: "person",
    revision,
    personalDeviceId: null,
  });
  const projection: WorkspaceProjection = {
    serverId: "30000000-0000-4000-8000-000000000001",
    organizationId: "40000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: "a".repeat(64),
    verifiedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    workspaces: [root, peer].map((id) => ({
      id,
      name: "Workspace",
      operationId: id,
      state: "ready",
      localOrganizationId: "org",
      localWorkspaceId: id === root ? "root-space" : "peer-space",
      permissionVersion: 1,
      members: [{ userId: "person", role: "member", accessVersion: revision }],
    })),
  };
  const apply = () => authority.window.apply(projection, performance.now());
  apply();
  return { authority, projection, apply, spaces, prisma };
}

describe("managed workspace access status", () => {
  it("recognizes an accessible peer even though organization navigation is scoped to the entry workspace", async () => {
    const { authority } = setup();
    expect(await authority.spaceAccessStatus("session", "user", "peer-space")).toBe("available");
  });

  it.each(["archived", "removed membership"])(
    "confirms %s only from a fresh projection",
    async (change) => {
      const { authority, projection, apply } = setup();
      if (change === "archived") projection.workspaces[1]!.state = "disabled";
      else projection.workspaces[1]!.members = [];
      projection.workspaces[1]!.permissionVersion++;
      apply();
      expect(await authority.spaceAccessStatus("session", "user", "peer-space")).toBe("removed");
    },
  );

  it("treats an invalidated projection as unknown, not a removal", async () => {
    const { authority } = setup();
    authority.window.invalidate(peer);
    expect(await authority.spaceAccessStatus("session", "user", "peer-space")).toBe("unknown");
  });

  it("does not report a stale result when the projection changes during a membership read", async () => {
    const { authority, projection, apply, prisma } = setup();
    let finish!: (value: { id: string }) => void;
    vi.mocked(prisma.spaceMember.findFirst).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    const result = authority.spaceAccessStatus("session", "user", "peer-space");
    await vi.waitFor(() => expect(prisma.spaceMember.findFirst).toHaveBeenCalled());
    projection.workspaces[1]!.members = [];
    projection.workspaces[1]!.permissionVersion++;
    apply();
    finish({ id: "member" });
    expect(await result).toBe("unknown");
  });

  it("confirms a workspace whose local data has been deleted", async () => {
    const { authority, spaces } = setup();
    spaces.delete("peer-space");
    expect(await authority.spaceAccessStatus("session", "user", "peer-space")).toBe("removed");
  });
});
