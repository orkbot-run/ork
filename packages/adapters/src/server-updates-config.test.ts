// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureServerUpdates,
  loadServerUpdatesConfig,
  parseServerUpdatesConfig,
} from "./server-updates-config.js";

const config = {
  version: 1,
  installationId: "00000000-0000-4000-8000-000000000001",
  controllerAccountKey: "a".repeat(64),
  channel: "stable",
  adapter: {
    kind: "easypanel",
    deploymentTrigger: "https://panel.example.test/api/deploy/fixture-deploy-token",
  },
};
const roots: string[] = [];
const uid = process.getuid?.() ?? 1000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ork-updates-"));
  roots.push(root);
  return { root, path: join(root, "updates.json") };
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("private operator update configuration", () => {
  it("is disabled when absent and atomically persists separate private configuration", () => {
    const { root, path } = fixture();
    writeFileSync(join(root, "environment.json"), "fixture-existing-secrets", { mode: 0o600 });
    expect(loadServerUpdatesConfig(path, uid)).toBeNull();
    configureServerUpdates({ root, config, uid });
    expect(loadServerUpdatesConfig(path, uid)).toEqual(config);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "environment.json"), "utf8")).toBe("fixture-existing-secrets");
    configureServerUpdates({
      root,
      config: {
        ...config,
        adapter: {
          ...config.adapter,
          deploymentTrigger: "https://panel.example.test/api/deploy/rotated-fixture-token",
        },
      },
      uid,
    });
    expect(loadServerUpdatesConfig(path, uid)?.installationId).toBe(config.installationId);
    expect(() =>
      configureServerUpdates({ root, config: { ...config, channel: "preview" }, uid }),
    ).toThrow();
    expect(() =>
      configureServerUpdates({
        root,
        config: { ...config, controllerAccountKey: "b".repeat(64) },
        uid,
      }),
    ).toThrow();
    expect(() =>
      configureServerUpdates({
        root,
        config: { ...config, installationId: "00000000-0000-4000-8000-000000000002" },
        uid,
      }),
    ).toThrow();
  });

  it.each([
    { ...config, version: 2 },
    { ...config, channel: "main" },
    { ...config, controllerAccountKey: "A".repeat(64) },
    { ...config, installationId: "invalid" },
    { ...config, auto: true },
    ...[
      "http://panel.example.test/api/deploy/fixture-deploy-token",
      "https://panel.example.test/api/deploy/short",
      "https://panel.example.test/api/other/fixture-deploy-token",
      "https://panel.example.test/api/deploy/fixture-deploy-token?secret=private",
      "https://user:secret@panel.example.test/api/deploy/fixture-deploy-token",
      "https://panel.example.test/api/deploy/fixture-deploy-token#hash",
    ].map((deploymentTrigger) => ({
      ...config,
      adapter: { ...config.adapter, deploymentTrigger },
    })),
  ])("fails closed on unsupported or unsafe configuration", (input) => {
    expect(() => parseServerUpdatesConfig(input)).toThrow(
      /^Invalid private server update configuration\.$/,
    );
  });

  it("rejects symlinks, hardlinks, public mode, wrong ownership and oversized files", () => {
    const { root, path } = fixture();
    configureServerUpdates({ root, config, uid });
    expect(() => loadServerUpdatesConfig(path, uid + 1)).toThrow();
    chmodSync(path, 0o644);
    expect(() => loadServerUpdatesConfig(path, uid)).toThrow();
    chmodSync(path, 0o600);
    linkSync(path, join(root, "linked"));
    expect(() => loadServerUpdatesConfig(path, uid)).toThrow();
    rmSync(join(root, "linked"));
    rmSync(path);
    symlinkSync(join(root, "missing"), path);
    expect(() => loadServerUpdatesConfig(path, uid)).toThrow();
    rmSync(path);
    writeFileSync(path, "x".repeat(8193), { mode: 0o600 });
    expect(() => loadServerUpdatesConfig(path, uid)).toThrow();
  });

  it("rejects public and symlinked parent directories without touching existing files", () => {
    const { root, path } = fixture();
    configureServerUpdates({ root, config, uid });
    chmodSync(root, 0o755);
    expect(() => loadServerUpdatesConfig(path, uid)).toThrow();
    chmodSync(root, 0o700);
    const other = fixture();
    symlinkSync(root, join(other.root, "alias"));
    expect(() =>
      configureServerUpdates({ root: join(other.root, "alias"), config, uid }),
    ).toThrow();
    expect(loadServerUpdatesConfig(path, uid)).toEqual(config);
  });
});
