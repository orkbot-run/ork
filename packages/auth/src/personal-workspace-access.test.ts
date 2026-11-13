// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

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
