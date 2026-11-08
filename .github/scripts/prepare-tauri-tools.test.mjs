// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  download,
  installNsisToolset,
  prepareTauriTools,
  tauriCache,
  verifySha256,
} from "./prepare-tauri-tools.mjs";

test("asset download authenticates without arguments and falls back to the pinned official release", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-tool-download-"));
  try {
    const target = path.join(root, "asset");
    const bytes = Buffer.from("fixture");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const calls = [];
    download(
      ["owner/repo", "123", digest, "https://github.com/owner/repo/releases/download/v1/file"],
      target,
      "fixture-token",
      (command, args, options) => {
        calls.push({ command, args, options });
        if (calls.length === 1) throw new Error("simulated outage");
        writeFileSync(target, bytes);
      },
    );
    assert.equal(calls.length, 2);
    assert.ok(
      calls[0].args.includes("https://api.github.com/repos/owner/repo/releases/assets/123"),
    );
    assert.ok(calls[0].args.includes("--config"));
    assert.ok(calls[0].options.input.includes("fixture-token"));
    assert.ok(!calls[0].args.join(" ").includes("fixture-token"));
    assert.equal(calls[1].options.input, undefined);
    assert.ok(calls[1].args.includes("https://github.com/owner/repo/releases/download/v1/file"));
    assert.equal(readFileSync(target, "utf8"), "fixture");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects corrupted assets without fallback or exposing credentials", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-tool-download-"));
  try {
    const target = path.join(root, "asset");
    let attempts = 0;
    assert.throws(
      () =>
        download(
          ["owner/repo", "123", "0".repeat(64), "https://github.com/owner/repo/file"],
          target,
          "fixture-token",
          () => {
            attempts++;
            writeFileSync(target, "wrong");
          },
        ),
      /checksum mismatch/,
    );
    assert.equal(attempts, 1);
    assert.throws(
      () =>
        download(
          ["owner/repo", "123", "0".repeat(64), "https://github.com/owner/repo/file"],
          target,
          "fixture-token",
          () => {
            throw new Error("fixture-token");
          },
        ),
      (error) => !error.message.includes("fixture-token"),
    );
    assert.throws(() => download([], target, "bad\ntoken", () => {}), /Invalid GitHub token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
