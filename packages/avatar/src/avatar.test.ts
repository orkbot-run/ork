// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the standalone avatar build and offline suites pass", () => {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  for (const args of [
    ["scripts/build.mjs"],
    ["--test", "test/generator.test.mjs", "test/server.test.mjs"],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }
});
