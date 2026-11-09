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

it("distinguishes workspace setup from personal Accounts authorization", () => {
  const instructions = serverClaimInstructions("23456789AB", Math.floor(Date.now() / 1000) + 600);
  const lines = instructions.trim().split("\n");
  expect(lines[0]).toBe("Connect your server");
  expect(instructions).toContain("workspace dashboard");
  expect(instructions).toContain("Personal account");
  const link = new URL(lines.find((line) => line.trim().includes("#code="))!.trim());
  expect(link.origin + link.pathname).toBe("https://accounts.ork.run/account/connect-server");
  expect(link.search).toBe("");
  expect(link.hash).toBe("#code=23456789AB");
  expect(lines).toContain("   https://accounts.ork.run/account/connect-server");
  expect(instructions).toContain("Setup code: 23456789AB");
  expect(instructions).toContain("expires in 10 minutes");
  expect(() => serverClaimInstructions("invalid", Math.floor(Date.now() / 1000) + 600)).toThrow();
});

it("sends an existing server's owner to the workspace dashboard", () => {
  const instructions = serverClaimInstructions(
    "23456789AB",
    Math.floor(Date.now() / 1000) + 600,
    true,
  );
  expect(instructions).toContain("workspace dashboard");
  expect(instructions).toContain("23456789AB");
  expect(instructions).toContain("current owner");
  expect(instructions).toContain("expires in 10 minutes");
  expect(instructions).not.toContain("connect-server#code");
});

it.each([false, true])("shows the actual fallback lifetime for workspace %s", (workspace) => {
  const instructions = serverClaimInstructions(
    "23456789AB",
    Math.floor(Date.now() / 1000) + 300,
    workspace,
  );
  expect(instructions).toContain("expires in 5 minutes");
  expect(() =>
    serverClaimInstructions("23456789AB", Math.floor(Date.now() / 1000) - 1, workspace),
  ).toThrow();
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
