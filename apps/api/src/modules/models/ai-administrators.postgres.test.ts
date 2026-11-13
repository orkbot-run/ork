// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@orkbot/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setAIAdministrator } from "./ai-administrators.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.COPY_TEST_DATABASE) &&
  Boolean(process.env.DATABASE_URL);
const db = enabled ? createDb(process.env.DATABASE_URL!, { encryptContent: false }) : undefined;
const system = <T>(work: () => Promise<T>) =>
  runAsSystem("operator delegation PostgreSQL test", work);
const accountKey = "a".repeat(64);
const fingerprint = "b".repeat(64);
const organizationId = "operator-delegation-fixture";

describe.skipIf(!enabled)("explicit installation AI administrator delegation", () => {
  beforeEach(async () =>
    system(async () => {
      await db!.prisma.aIConnectionAdministrator.deleteMany();
      await db!.prisma.installationIdentity.deleteMany();
      await db!.prisma.auditEvent.deleteMany({ where: { organizationId } });
      await db!.prisma.organization.upsert({
        where: { id: organizationId },
        create: {
          id: organizationId,
          slug: organizationId,
          name: "Operator fixture",
          createdAt: new Date(),
        },
        update: {},
      });
      await db!.prisma.installationIdentity.create({
        data: {
          issuer: "https://accounts.example.test",
          publicKey: "fixture-public-key",
          privateKeyCipher: "fixture-encrypted-private-key",
          keyFingerprint: fingerprint,
          operationId: randomUUID(),
          challenge: "fixture-challenge",
          state: "ready",
          localOrganizationId: organizationId,
          bindingVersion: 7,
        },
      });
    }),
  );
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("records both explicit grant and revocation in the same database transaction", async () => {
    await setAIAdministrator(db!.prisma, { accountKey, fingerprint, enabled: true });
    expect(
      await system(() =>
        db!.prisma.aIConnectionAdministrator.findUnique({ where: { accountKey } }),
      ),
    ).toMatchObject({ accountKey, bindingVersion: 7 });
    await setAIAdministrator(db!.prisma, { accountKey, fingerprint, enabled: false });
    expect(await system(() => db!.prisma.aIConnectionAdministrator.count())).toBe(0);
    const audit = await system(() =>
      db!.prisma.auditEvent.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } }),
    );
    expect(audit.map((event) => [event.action, event.targetId, event.metadata])).toEqual([
      ["ai.administrator.granted", accountKey, { bindingVersion: 7 }],
      ["ai.administrator.revoked", accountKey, { bindingVersion: 7 }],
    ]);
  });

  it("refuses a changed installation fingerprint without modifying an existing delegation", async () => {
    await setAIAdministrator(db!.prisma, { accountKey, fingerprint, enabled: true });
    await expect(
      setAIAdministrator(db!.prisma, { accountKey, fingerprint: "c".repeat(64), enabled: false }),
    ).rejects.toThrow("Installation binding changed");
    expect(await system(() => db!.prisma.aIConnectionAdministrator.count())).toBe(1);
    expect(await system(() => db!.prisma.auditEvent.count({ where: { organizationId } }))).toBe(1);
  });

  it("requires a ready binding and never infers an account key from an email", async () => {
    await expect(
      setAIAdministrator(db!.prisma, {
        accountKey: "owner@example.test",
        fingerprint,
        enabled: true,
      }),
    ).rejects.toThrow("exact account key");
    await system(() =>
      db!.prisma.installationIdentity.update({
        where: { id: "local" },
        data: { state: "enrolling" },
      }),
    );
    await expect(
      setAIAdministrator(db!.prisma, { accountKey, fingerprint, enabled: true }),
    ).rejects.toThrow("Installation binding changed");
    expect(await system(() => db!.prisma.aIConnectionAdministrator.count())).toBe(0);
    expect(await system(() => db!.prisma.auditEvent.count({ where: { organizationId } }))).toBe(0);
  });
  it("does not delegate a resumed desktop request to a newer binding", async () => {
    await expect(
      setAIAdministrator(db!.prisma, {
        accountKey,
        fingerprint,
        enabled: true,
        expectedBindingVersion: 6,
      }),
    ).rejects.toThrow("Installation binding changed");
    expect(await system(() => db!.prisma.aIConnectionAdministrator.count())).toBe(0);
    expect(await system(() => db!.prisma.auditEvent.count({ where: { organizationId } }))).toBe(0);
    await setAIAdministrator(db!.prisma, {
      accountKey,
      fingerprint,
      enabled: true,
      expectedBindingVersion: 7,
    });
    expect(await system(() => db!.prisma.aIConnectionAdministrator.count())).toBe(1);
  });
});
