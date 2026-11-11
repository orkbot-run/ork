// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { runAsTenant } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const postgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

postgres("workspace model policy database permissions", () => {
  const tag = `${process.pid}-${Date.now()}`;
  const org = `policy-org-${tag}`;
  const otherOrg = `policy-other-${tag}`;
  const space = `policy-space-${tag}`;
  const otherSpace = `policy-other-space-${tag}`;
  const ownerId = `policy-owner-${tag}`;
  const memberId = `policy-member-${tag}`;
  const outsiderId = `policy-outsider-${tag}`;
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!);
    for (const id of [ownerId, memberId, outsiderId]) {
      await owner.prisma.user.create({
        data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
      });
    }
    for (const id of [org, otherOrg])
      await owner.prisma.organization.create({
        data: { id, name: id, slug: id, createdAt: new Date() },
      });
    await owner.prisma.space.create({ data: { id: space, organizationId: org, name: "Policy" } });
    await owner.prisma.space.create({
      data: { id: otherSpace, organizationId: otherOrg, name: "Other" },
    });
    for (const [organizationId, userId, role] of [
      [org, ownerId, " admin, owner "],
      [org, memberId, "member"],
      [otherOrg, outsiderId, "owner"],
    ] as const)
      await owner.prisma.member.create({
        data: {
          id: `${organizationId}-${userId}`,
          organizationId,
          userId,
          role,
          createdAt: new Date(),
        },
      });
  });
  afterAll(async () => {
    await owner.prisma.organization.deleteMany({ where: { id: { in: [org, otherOrg] } } });
    await owner.prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } });
    await Promise.all([owner.pool.end(), app.pool.end()]);
  });
  it("allows an owner to set policy, members to read it, and prevents members from changing it", async () => {
    const data = {
      organizationId: org,
      provider: "provider",
      modelId: "model",
      secretId: "id",
      secretRef: "encrypted",
    };
    await runAsTenant({ userId: ownerId, spaceId: space }, () =>
      app.prisma.workspaceModelPolicy.create({ data }),
    );
    expect(
      await runAsTenant({ userId: memberId, spaceId: space }, () =>
        app.prisma.workspaceModelPolicy.findUnique({ where: { organizationId: org } }),
      ),
    ).toMatchObject({ modelId: "model" });
    const result = await runAsTenant({ userId: memberId, spaceId: space }, () =>
      app.prisma.workspaceModelPolicy.updateMany({
        where: { organizationId: org },
        data: { modelId: "unauthorized" },
      }),
    );
    expect(result.count).toBe(0);
    const deleted = await runAsTenant({ userId: memberId, spaceId: space }, () =>
      app.prisma.workspaceModelPolicy.deleteMany({ where: { organizationId: org } }),
    );
    expect(deleted.count).toBe(0);
  });
  it("does not let another organization read or overwrite this policy", async () => {
    const scope = { userId: outsiderId, spaceId: otherSpace };
    expect(
      await runAsTenant(scope, () =>
        app.prisma.workspaceModelPolicy.findUnique({ where: { organizationId: org } }),
      ),
    ).toBeNull();
    await expect(
      runAsTenant(scope, () =>
        app.prisma.workspaceModelPolicy.create({
          data: { organizationId: org, provider: "x", modelId: "x", secretId: "x", secretRef: "x" },
        }),
      ),
    ).rejects.toThrow();
  });
});
