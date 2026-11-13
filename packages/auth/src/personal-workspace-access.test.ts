// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";
import type { InstallationClient } from "./installation-client.js";
import { FilePersonalRevocations } from "./personal-revocations.js";
import { PersonalWorkspaceAccess } from "./personal-workspace-access.js";

it("retains a global refusal when the database cannot supply individual device IDs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-personal-refusal-"));
  try {
    const failure = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const prisma = { personalWorkspaceDevice: { findMany: failure } } as unknown as PrismaClient;
    const journal = new FilePersonalRevocations(directory);
    const access = new PersonalWorkspaceAccess(prisma, {} as InstallationClient, journal);
    await expect(access.refuseInstallation()).rejects.toThrow("database unavailable");
    expect(await new FilePersonalRevocations(directory).restorationCheckpoint()).toHaveLength(1);
    await journal.confirmRestoration(await journal.restorationCheckpoint());
    access.confirmed([]);
    await expect(access.refuseInstallation()).rejects.toThrow("database unavailable");
    expect(await new FilePersonalRevocations(directory).restorationCheckpoint()).toHaveLength(1);
    await expect(access.refuseInstallation()).rejects.toThrow("database unavailable");
    expect(await new FilePersonalRevocations(directory).restorationCheckpoint()).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("permits retained offline personal V2 after a late V1 refusal but honors global restore and device evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-personal-scoped-refusal-"));
  try {
    const configuration = {
      serverId: randomUUID(),
      organizationId: randomUUID(),
      bindingVersion: 2,
      keyFingerprint: "a".repeat(64),
    };
    const row = {
      id: randomUUID(),
      workspaceId: randomUUID(),
      userId: "fixture-user",
      centralSubject: "fixture-subject",
      membershipVersion: "fixture-membership",
      permissionVersion: 2,
      bindingVersion: 2,
      keyFingerprint: configuration.keyFingerprint,
      revokedAt: null,
    };
    const prisma = {
      personalWorkspaceDevice: { findUnique: async () => row },
      $queryRaw: async () => [{ allowed: true }],
      centralWorkspaceBinding: {
        findUnique: async () => ({
          serverId: configuration.serverId,
          centralOrganizationId: configuration.organizationId,
          permissionVersion: 2,
          bindingVersion: 2,
        }),
      },
      centralWorkspaceAccess: {
        findUnique: async () => ({
          active: true,
          centralSubject: row.centralSubject,
          membershipVersion: row.membershipVersion,
        }),
      },
    } as unknown as PrismaClient;
    const journal = new FilePersonalRevocations(directory);
    const access = new PersonalWorkspaceAccess(
      prisma,
      { configuration: async () => configuration } as InstallationClient,
      journal,
    );
    await journal.refuseInstallation({ ...configuration, bindingVersion: 1 });
    expect(await access.device(row.id)).toEqual(row);
    await journal.refuseInstallation();
    expect(await access.device(row.id)).toBeNull();
    await journal.confirmRestoration(await journal.restorationCheckpoint(configuration));
    expect(await access.device(row.id)).toEqual(row);
    await journal.revoke([row.id]);
    expect(await access.device(row.id)).toBeNull();
    expect(
      await journal.restorationCheckpoint({ ...configuration, bindingVersion: 1 }),
    ).toHaveLength(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
