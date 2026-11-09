// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DeploymentJournal } from "./deployment-journal.js";

it("retains acknowledged operations across updater restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-deployment-"));
  try {
    const operation = {
      idempotencyKey: "test-operation-0001",
      revision: "a".repeat(40),
      state: "running" as const,
    };
    expect(await new DeploymentJournal(directory).read()).toBeNull();
    await new DeploymentJournal(directory).write(operation);
    expect(await new DeploymentJournal(directory).read()).toEqual(operation);
    expect(JSON.parse(await readFile(path.join(directory, ".ork-update.json"), "utf8"))).toEqual(
      operation,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
