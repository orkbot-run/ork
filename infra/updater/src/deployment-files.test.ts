// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { stageDeploymentFiles } from "./deployment-files.js";

async function installation() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ork-templates-"));
  const filename = path.join(directory, "docker-compose.images.yml");
  await writeFile(filename, "old-template");
  await writeFile(
    path.join(directory, ".orkbot-compose-state.json"),
    JSON.stringify({
      files: {
        "docker-compose.images.yml": createHash("sha256").update("old-template").digest("hex"),
      },
    }),
  );
  return { directory, filename };
}

it("restores the previous templates before recovering the previous image", async () => {
  const { directory, filename } = await installation();
  try {
    const files = await stageDeploymentFiles(
      directory,
      "a".repeat(40),
      async () => new Response("new-template"),
    );
    expect(await readFile(filename, "utf8")).toBe("old-template");
    await files.apply();
    expect(await readFile(filename, "utf8")).toBe("new-template");
    await files.restore();
    expect(await readFile(filename, "utf8")).toBe("old-template");
    const retry = await stageDeploymentFiles(
      directory,
      "a".repeat(40),
      async () => new Response("new-template"),
    );
    await retry.apply();
    await retry.commit();
    await expect(
      stageDeploymentFiles(directory, "b".repeat(40), async () => new Response("third-template")),
    ).resolves.toBeDefined();
  } finally {
    await rm(directory, { recursive: true });
  }
});

it("preserves operator changes and refuses to replace them", async () => {
  const { directory, filename } = await installation();
  try {
    await writeFile(filename, "operator-template");
    await expect(
      stageDeploymentFiles(directory, "a".repeat(40), async () => new Response("new-template")),
    ).rejects.toThrow("operator");
    expect(await readFile(filename, "utf8")).toBe("operator-template");
  } finally {
    await rm(directory, { recursive: true });
  }
});
