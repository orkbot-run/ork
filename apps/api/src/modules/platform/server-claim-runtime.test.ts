// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { InstallationClient } from "@orkbot/auth/installation-client";
import { afterAll, expect, it, vi } from "vitest";
import {
  loadServerClaimRuntime,
  serverEnrollmentInstructions,
  startServerEnrollment,
} from "./server-claim-runtime.js";

const root = mkdtempSync(path.join(tmpdir(), "ork-claim-runtime-"));
const loader = pathToFileURL(
  path.resolve(import.meta.dirname, "../../../../../infra/compose/selfhost-runtime.mjs"),
).href;
afterAll(() => rmSync(root, { recursive: true, force: true }));

it("issues a current enrollment code and shows the fingerprint to verify", async () => {
  const fingerprint = "a".repeat(64);
  const installation = {
    resetExpiredEnrollment: vi.fn(),
    resumePendingEnrollment: vi.fn().mockResolvedValue(null),
    beginEnrollment: vi.fn().mockResolvedValue({
      code: "23456789AB",
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      keyFingerprint: fingerprint,
    }),
  } as unknown as InstallationClient;
  const instructions = await startServerEnrollment(installation);
  expect(installation.beginEnrollment).toHaveBeenCalledExactlyOnceWith("Ork server");
  expect(instructions).toContain("https://app.ork.run/account/connect-server#code=23456789AB");
  expect(instructions).toContain(fingerprint);
  expect(instructions).toContain("expires in 15 minutes");
  expect(() =>
    serverEnrollmentInstructions("invalid", Math.floor(Date.now() / 1000) + 900, fingerprint),
  ).toThrow();
  expect(() =>
    serverEnrollmentInstructions("23456789AB", Math.floor(Date.now() / 1000) - 1, fingerprint),
  ).toThrow();
});

it("does not start a second enrollment when a previous one is ready", async () => {
  const installation = {
    resetExpiredEnrollment: vi.fn(),
    resumePendingEnrollment: vi.fn().mockResolvedValue({ serverId: "fixture" }),
    beginEnrollment: vi.fn(),
  } as unknown as InstallationClient;
  expect(await startServerEnrollment(installation)).toBe("Server enrollment confirmed.\n");
  expect(installation.beginEnrollment).not.toHaveBeenCalled();
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
