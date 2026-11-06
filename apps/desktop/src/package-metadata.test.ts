// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "../..");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("desktop distribution boundaries", () => {
  it("packages the native client with complete notices and no Electron runtime", () => {
    const manifest = json(path.join(desktop, "package.json"));
    const config = json(path.join(desktop, "src-tauri/tauri.conf.json"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(Object.keys(dependencies).filter((name) => name.includes("electron"))).toEqual([]);
    expect(manifest.main).toBeUndefined();
    expect(manifest.scripts.bundle).toBe("tauri build");
    expect(config.version).toBe("../package.json");
    expect(config.plugins.updater.pubkey).toBe("");
    expect(config.plugins.updater.requireSignedVersion).toBe(true);
    expect(config.bundle.linux.deb.depends).toContain("libxdo3");
    for (const file of ["LICENSE", "LICENSE-POLYFORM", "LICENSE.md", "NOTICE"]) {
      expect(config.bundle.resources[`../../../${file}`]).toBe(`licenses/${file}`);
    }
    const cargo = readFileSync(path.join(desktop, "src-tauri/Cargo.toml"), "utf8");
    expect(cargo).toContain(`version = "${manifest.version}"`);
  });

  it("keeps PR native installers unsigned and repository permissions read-only", () => {
    const source = readFileSync(path.join(root, ".github/workflows/desktop-tauri.yml"), "utf8");
    const workflow = parse(source);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.pull_request).toBeDefined();
    expect(workflow.on.workflow_dispatch).toBeNull();
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("pull_request_target");
    for (const job of Object.values(workflow.jobs) as Array<Record<string, unknown>>) {
      expect(job.permissions).toBeUndefined();
    }
    expect(source).toContain('ORKBOT_ENABLE_AUTO_UPDATE: "0"');
    expect(source).toContain("persist-credentials: false");
  });
});
