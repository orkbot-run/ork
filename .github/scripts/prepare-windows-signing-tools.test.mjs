// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareWindowsSigningTools } from "./prepare-windows-signing-tools.mjs";

const bytes = Buffer.from("offline fixture");
const hash = createHash("sha512").update(bytes).digest("hex");
const assets = [
  {
    url: "https://fixture.test/sdk",
    sha512: hash,
    file: "bin/signtool.exe",
    variable: "WINDOWS_SIGNTOOL_PATH",
  },
  {
    url: "https://fixture.test/client",
    sha512: hash,
    file: "bin/dlib.dll",
    variable: "WINDOWS_SIGNING_DLIB_PATH",
  },
];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-signing-test-"));
  const env = {
    RUNNER_OS: "Windows",
    RUNNER_TEMP: root,
    GITHUB_ENV: path.join(root, "github-env"),
  };
  writeFileSync(env.GITHUB_ENV, "existing=value\n");
  return { root, env };
}
function executor({ corrupt = false, missing = false } = {}) {
  const calls = [];
  function execute(command, args) {
    calls.push(command);
    if (command === "curl.exe")
      writeFileSync(args[args.indexOf("--output") + 1], corrupt ? "corrupt" : bytes);
    else {
      const destination = args.find((arg) => arg.startsWith("-o")).slice(2);
      const asset = assets[Number(path.basename(destination))];
      if (missing && asset.variable === "WINDOWS_SIGNING_DLIB_PATH") return;
      const file = path.join(destination, asset.file);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "fixture tool");
    }
  }
  return { execute, calls };
}

test("verified packages retain both tool trees and expose paths only after extraction", () => {
  const { root, env } = fixture();
  try {
    const { execute, calls } = executor();
    prepareWindowsSigningTools(env, execute, assets);
    assert.deepEqual(calls, ["curl.exe", "curl.exe", "7z.exe", "7z.exe"]);
    const lines = readFileSync(env.GITHUB_ENV, "utf8").trim().split("\n");
    assert.equal(lines[0], "existing=value");
    for (const [index, asset] of assets.entries()) {
      const [variable, file] = lines[index + 1].split("=");
      assert.equal(variable, asset.variable);
      assert.ok(existsSync(file));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt download is rejected before extraction and leaves no paths or files", () => {
  const { root, env } = fixture();
  try {
    const { execute, calls } = executor({ corrupt: true });
    assert.throws(() => prepareWindowsSigningTools(env, execute, assets), /verification failed/);
    assert.deepEqual(calls, ["curl.exe"]);
    assert.equal(readFileSync(env.GITHUB_ENV, "utf8"), "existing=value\n");
    assert.deepEqual(readdirSync(root), ["github-env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing tool fails closed and removes extracted files", () => {
  const { root, env } = fixture();
  try {
    const { execute } = executor({ missing: true });
    assert.throws(() => prepareWindowsSigningTools(env, execute, assets));
    assert.equal(readFileSync(env.GITHUB_ENV, "utf8"), "existing=value\n");
    assert.deepEqual(readdirSync(root), ["github-env"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects untrusted runner configuration before execution", () => {
  const { root, env } = fixture();
  try {
    const { execute, calls } = executor();
    assert.throws(() =>
      prepareWindowsSigningTools({ ...env, RUNNER_OS: "Linux" }, execute, assets),
    );
    assert.throws(() =>
      prepareWindowsSigningTools({ ...env, RUNNER_TEMP: `${root}\ninjected` }, execute, assets),
    );
    assert.deepEqual(calls, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
