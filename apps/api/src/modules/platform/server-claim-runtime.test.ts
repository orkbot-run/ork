// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";
import { loadServerClaimRuntime, serverClaimInstructions } from "./server-claim-runtime.js";

const root = mkdtempSync(path.join(tmpdir(), "ork-claim-runtime-"));
const loader = pathToFileURL(
  path.resolve(import.meta.dirname, "../../../../../infra/compose/selfhost-runtime.mjs"),
).href;
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("offers the same one-time code as an Accounts link and manual entry", () => {
  const instructions = serverClaimInstructions("23456789AB");
  const lines = instructions.trim().split("\n");
  const link = new URL(lines[1]!);
  expect(link.origin + link.pathname).toBe("https://accounts.ork.run/account/connect-server");
  expect(link.search).toBe("");
  expect(link.hash).toBe("#code=23456789AB");
  expect(lines.at(-3)).toBe("23456789AB");
  expect(() => serverClaimInstructions("invalid")).toThrow();
});

it("loads a private Compose role file using the production runtime loader", async () => {
  const file = path.join(root, "environment.json");
  writeFileSync(
    file,
    JSON.stringify({ ORKBOT_BOOTSTRAP_SECRET: "fixture", DATABASE_URL: "fixture" }),
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {};
  await loadServerClaimRuntime(env, file, loader);
  expect(env).toEqual({ ORKBOT_BOOTSTRAP_SECRET: "fixture", DATABASE_URL: "fixture" });
});

it("rejects nonprivate files and symbolic links", async () => {
  const file = path.join(root, "environment.json");
  writeFileSync(file, "{}", { mode: 0o600 });
  chmodSync(file, 0o644);
  await expect(loadServerClaimRuntime({}, file, loader)).rejects.toThrow();
  chmodSync(file, 0o600);
  const link = path.join(root, "link.json");
  symlinkSync(file, link);
  await expect(loadServerClaimRuntime({}, link, loader)).rejects.toThrow();
});

it("uses an existing managed environment without reading a role file", async () => {
  const env: NodeJS.ProcessEnv = { ORKBOT_BOOTSTRAP_SECRET: "existing" };
  await loadServerClaimRuntime(env, path.join(root, "missing"), "file:///nonexistent-loader.mjs");
  expect(env.ORKBOT_BOOTSTRAP_SECRET).toBe("existing");
});
