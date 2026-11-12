// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { oidcAccountSubject } from "@orkbot/auth";
import { createDb, runAsSystem } from "@orkbot/db";
import { describe, expect, it } from "vitest";
import { dashboardModelControl } from "./dashboard-model-control.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const postgres =
  process.env.VERIFY_DATABASE && databaseUrl && migrationUrl && databaseUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

postgres("initialize a connected workspace before the owner opens the app", () => {
  it("initializes exactly once for concurrent verified owner requests and rejects a different owner", async () => {
    const db = createDb(databaseUrl!);
    const admin = createDb(migrationUrl!);
    const issuer = "https://accounts.example.test";
    const subject = `dashboard-owner-${randomUUID()}`;
    const email = `${subject}@example.test`;
    const accountKey = oidcAccountSubject(issuer, subject);
    const organizationId = randomUUID();
    const claimId = randomUUID().replaceAll("-", "").repeat(2);
    const previous = await admin.prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    try {
      await admin.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          nativeAccountsOwnerKey: accountKey,
          nativeAccountsOrganizationId: organizationId,
          nativeAccountsWorkspaceClaimId: claimId,
        },
        update: {
          nativeAccountsOwnerKey: accountKey,
          nativeAccountsOrganizationId: organizationId,
          nativeAccountsWorkspaceClaimId: claimId,
        },
      });
      const control = dashboardModelControl({
        prisma: db.prisma,
        issuer,
        origin: "https://server.example.test",
        bootstrapSecret: "example-secret",
        connectionStatus: async () => "connected",
        verifyGrant: async () => ({
          subject,
          organizationId,
          claimId,
          id: randomUUID(),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          email,
          name: "Owner",
        }),
        dispatch: async (actor) => ({ userId: actor.userId, spaceId: actor.spaceId }),
      });
      const request = () =>
        new Request("https://server.example.test/api/workspace/model-control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "get", input: null, grant: "signed" }),
        });
      const responses = await Promise.all([control(request()), control(request())]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const results = await Promise.all(responses.map((response) => response.json()));
      expect(results[0]).toEqual(results[1]);
      const accounts = await runAsSystem("inspect owner fixture", () =>
        db.prisma.account.findMany({ where: { providerId: "oidc", accountId: accountKey } }),
      );
      expect(accounts).toHaveLength(1);
      const spaces = await runAsSystem("inspect workspace fixture", () =>
        db.prisma.space.findMany({
          where: { createdByUserId: accounts[0]!.userId, isDefault: true },
        }),
      );
      expect(spaces).toHaveLength(1);
      // A different signed subject cannot initialize the identity that claimed the host.
      const otherKey = oidcAccountSubject(issuer, "different-owner");
      await admin.prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { nativeAccountsOwnerKey: otherKey },
      });
      expect((await control(request())).status).toBe(403);
      expect(
        await runAsSystem("inspect missing identity", () =>
          db.prisma.account.findFirst({ where: { providerId: "oidc", accountId: otherKey } }),
        ),
      ).toBeNull();
      // Even the correct subject may not adopt an existing account by matching its email.
      const collision = dashboardModelControl({
        prisma: db.prisma,
        issuer,
        origin: "https://server.example.test",
        bootstrapSecret: "example-secret",
        connectionStatus: async () => "connected",
        verifyGrant: async () => ({
          subject: "different-owner",
          organizationId,
          claimId,
          id: randomUUID(),
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          email,
          name: "Other",
        }),
        dispatch: async () => ({ ok: true }),
      });
      expect((await collision(request())).status).toBe(400);
      expect(
        await runAsSystem("inspect email collision", () =>
          db.prisma.account.findFirst({ where: { providerId: "oidc", accountId: otherKey } }),
        ),
      ).toBeNull();
    } finally {
      const owner = await admin.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (owner) {
        const spaces = await admin.prisma.space.findMany({
          where: { createdByUserId: owner.id },
          select: { organizationId: true },
        });
        await admin.prisma.organization.deleteMany({
          where: { id: { in: spaces.map((space) => space.organizationId) } },
        });
        await admin.prisma.user.delete({ where: { id: owner.id } });
      }
      if (previous)
        await admin.prisma.deploymentSettings.update({
          where: { id: "default" },
          data: {
            nativeAccountsOwnerKey: previous.nativeAccountsOwnerKey,
            nativeAccountsOrganizationId: previous.nativeAccountsOrganizationId,
            nativeAccountsWorkspaceClaimId: previous.nativeAccountsWorkspaceClaimId,
          },
        });
      else await admin.prisma.deploymentSettings.deleteMany({ where: { id: "default" } });
      await Promise.all([db.pool.end(), admin.pool.end()]);
    }
  });
});
