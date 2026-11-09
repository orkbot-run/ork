// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export type DeploymentOperation = {
  idempotencyKey: string;
  revision: string;
  state: "accepted" | "running" | "succeeded" | "failed" | "unknown";
};

/** A durable acknowledgement prevents a lost HTTP response from replaying a deployment. */
export class DeploymentJournal {
  constructor(private readonly directory: string) {}

  async read(): Promise<DeploymentOperation | null> {
    try {
      const value = JSON.parse(
        await readFile(path.join(this.directory, ".ork-update.json"), "utf8"),
      );
      if (
        !/^[a-f0-9]{40}$/.test(value.revision) ||
        !/^[A-Za-z0-9-]{16,64}$/.test(value.idempotencyKey) ||
        !["accepted", "running", "succeeded", "failed", "unknown"].includes(value.state)
      )
        throw new Error("Invalid deployment journal.");
      return value as DeploymentOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(operation: DeploymentOperation): Promise<void> {
    const destination = path.join(this.directory, ".ork-update.json");
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(operation)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
