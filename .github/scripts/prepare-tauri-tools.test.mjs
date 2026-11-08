// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { prepareTauriTools, tauriCache, verifySha256 } from "./prepare-tauri-tools.mjs";

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
