// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  installNsisToolset,
  prepareTauriTools,
  tauriCache,
  verifySha256,
} from "./prepare-tauri-tools.mjs";

test("NSIS installation replaces the old cache with the extracted toolset", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-nsis-test-"));
  try {
    const source = path.join(root, "source");
    const destination = path.join(root, "cache");
    mkdirSync(path.join(source, "Plugins"), { recursive: true });
    mkdirSync(destination);
    writeFileSync(path.join(source, "Plugins", "plugin.dll"), "new tool");
    writeFileSync(path.join(destination, "stale"), "old tool");
    installNsisToolset(source, destination);
    assert.equal(readFileSync(path.join(destination, "Plugins", "plugin.dll"), "utf8"), "new tool");
    assert.equal(existsSync(path.join(destination, "stale")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packaging tools reject changed content and malformed checksums", () => {
  const bytes = Buffer.from("fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(verifySha256(bytes, digest), true);
  assert.equal(verifySha256(Buffer.from("changed"), digest), false);
  assert.equal(verifySha256(bytes, "not-a-digest"), false);
});

test("unsupported platforms and missing runner directories fail before downloading", () => {
  assert.throws(() => prepareTauriTools("macOS", {}), /Unsupported packaging platform/);
  assert.throws(() => prepareTauriTools("Linux", {}), /runner packaging directories/);
});

test("Linux uses the XDG cache only when it is an absolute path", () => {
  const root = path.resolve("fixture");
  const custom = path.join(root, "custom");
  assert.equal(
    tauriCache("Linux", { HOME: root, XDG_CACHE_HOME: custom }),
    path.join(custom, "tauri"),
  );
  assert.equal(
    tauriCache("Linux", { HOME: root, XDG_CACHE_HOME: "relative" }),
    path.join(root, ".cache", "tauri"),
  );
});
