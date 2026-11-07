// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composeDir = path.resolve(import.meta.dirname, "../../compose");

describe.each([
  "docker-compose.yml",
  "docker-compose.images.yml",
  "docker-compose.prod.yml",
  "docker-compose.topology.yml",
  "docker-compose.selfhost.yml",
])("%s production gateway", (file) => {
  const compose = parse(readFileSync(path.join(composeDir, file), "utf8"), { merge: true }) as {
    services: Record<
      string,
      { command?: string[]; working_dir?: string; environment?: Record<string, unknown> }
    >;
  };
  const web = compose.services.web;

  it("starts the compiled gateway directly so termination reaches Node without a compiler", () => {
    const command = web?.command ?? [];
    expect(web?.working_dir).toBe("/app/apps/web");
    expect(command[0]).toBe("node");
    if (file === "docker-compose.selfhost.yml") {
      expect(command.slice(0, 4)).toEqual([
        "node",
        "/app/infra/compose/selfhost-runtime.mjs",
        "/run/orkbot/environment.json",
        "node",
      ]);
    }
    expect(command).toContain("server/index.js");
    expect(command.slice(-4)).toEqual(["--host", "0.0.0.0", "--port", "5173"]);
    expect(command).not.toContain("pnpm");
    expect(command).not.toContain("preview");
    expect(command).not.toContain("node_modules/.bin/vite");
    expect(web?.environment ?? {}).not.toHaveProperty("RAYON_NUM_THREADS");
  });
});

it("starts the same gateway on Railway after dropping unrelated secrets", () => {
  const script = readFileSync(path.resolve(composeDir, "../railway/start.sh"), "utf8");
  expect(script).toMatch(
    /exec env -u RAILWAY_API_TOKEN[^\n]*\\\n\s+node --enable-source-maps apps\/web\/server\/index\.js --host 0\.0\.0\.0 --port 5173/,
  );
});
