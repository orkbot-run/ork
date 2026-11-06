// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerUpdatesConfig } from "@orkbot/adapters/server-updates-config";
import { expect, it, vi } from "vitest";
import { configureFromInput } from "./configure-server-updates.js";

it("delegates only an explicit local action to the initialized DB owner, preserving identity and secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "ork-update-cli-"));
  const uid = process.getuid?.() ?? 1000;
  const input = {
    channel: "stable",
    adapter: {
      kind: "easypanel",
      deploymentTrigger: "https://panel.example.test/api/deploy/fixture-deploy-token",
    },
  };
  const owner = vi.fn(async () => "a".repeat(64));
  try {
    writeFileSync(join(root, "environment.json"), "existing-environment", { mode: 0o600 });
    await expect(
      configureFromInput(input, { root, uid, delegateCurrentOwner: false }, owner),
    ).rejects.toThrow();
    expect(owner).not.toHaveBeenCalled();
    await expect(
      configureFromInput(
        { ...input, controllerAccountKey: "b".repeat(64) },
        { root, uid, delegateCurrentOwner: true },
        owner,
      ),
    ).rejects.toThrow();
    expect(owner).not.toHaveBeenCalled();
    await expect(
      configureFromInput(input, { root, uid, delegateCurrentOwner: true }, async () => null),
    ).rejects.toThrow();
    expect(loadServerUpdatesConfig(join(root, "updates.json"), uid)).toBeNull();
    await configureFromInput(input, { root, uid, delegateCurrentOwner: true }, owner);
    const first = loadServerUpdatesConfig(join(root, "updates.json"), uid);
    expect(first?.controllerAccountKey).toBe("a".repeat(64));
    await configureFromInput(
      {
        ...input,
        adapter: {
          ...input.adapter,
          deploymentTrigger: "https://panel.example.test/api/deploy/rotated-fixture-token",
        },
      },
      { root, uid, delegateCurrentOwner: true },
      owner,
    );
    expect(loadServerUpdatesConfig(join(root, "updates.json"), uid)?.installationId).toBe(
      first?.installationId,
    );
    expect(readFileSync(join(root, "environment.json"), "utf8")).toBe("existing-environment");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
