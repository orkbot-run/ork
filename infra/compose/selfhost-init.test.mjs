// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialize, publicOrigin } from "./selfhost-init.mjs";
import { readRuntimeConfig } from "./selfhost-runtime.mjs";

const origin = "https://server.example.test";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ork-selfhost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, origin };
}

test("first boot generates private role-specific secrets without operator credentials", (t) => {
  const options = fixture(t);
  const result = initialize(options);
  assert.match(result.bootstrapSecret, /^[A-Za-z0-9_-]{43}$/);
  const api = readRuntimeConfig(join(options.root, "api/environment.json"));
  const worker = readRuntimeConfig(join(options.root, "worker/environment.json"));
  const web = readRuntimeConfig(join(options.root, "web/environment.json"));
  const migrate = readRuntimeConfig(join(options.root, "migrate/environment.json"));
  assert.equal(api.AUTH_ACCOUNTS_ENABLED, "true");
  assert.equal(worker.AUTH_ACCOUNTS_ENABLED, "true");
  assert.equal(api.AUTH_PASSWORD_ENABLED, "false");
  assert.equal(api.ORKBOT_BOOTSTRAP_SECRET, result.bootstrapSecret);
  assert.equal(api.BETTER_AUTH_URL, origin);
  assert.equal(api.DATABASE_URL, worker.DATABASE_URL);
  assert.equal(api.DATABASE_URL, migrate.DATABASE_URL);
  assert.notEqual(migrate.DATABASE_URL, migrate.DATABASE_MIGRATION_URL);
  assert.equal(web.API_PROXY_TARGET, "http://ork-selfhost-api:3100");
  assert.equal(web.ORKBOT_HOST, "server.example.test");
  assert.equal(web.RAYON_NUM_THREADS, undefined);
  assert.match(api.ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  for (const config of [api, worker, web, migrate]) {
    assert.equal(config.OIDC_CLIENT_ID, undefined);
    assert.equal(config.OIDC_CLIENT_SECRET, undefined);
  }
  assert.equal(worker.BETTER_AUTH_SECRET, undefined);
  assert.equal(worker.ORKBOT_BOOTSTRAP_SECRET, undefined);
  assert.equal(web.DATABASE_URL, undefined);
  assert.equal(lstatSync(join(options.root, "installation.json")).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(options.root, "api")).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(options.root, "api/environment.json")).mode & 0o777, 0o600);
});

test("restart and interrupted initialization reuse every credential", (t) => {
  const options = fixture(t);
  const first = initialize(options);
  const state = readFileSync(join(options.root, "installation.json"), "utf8");
  const original = readFileSync(join(options.root, "api/environment.json"), "utf8");
  rmSync(join(options.root, "api/environment.json"));
  const resumed = initialize(options);
  assert.deepEqual(resumed, first);
  assert.equal(readFileSync(join(options.root, "installation.json"), "utf8"), state);
  assert.equal(readFileSync(join(options.root, "api/environment.json"), "utf8"), original);
});

test("upgrades only the exact previously generated worker configuration without rotating credentials", (t) => {
  const options = fixture(t);
  initialize(options);
  const state = readFileSync(join(options.root, "installation.json"), "utf8");
  const api = readFileSync(join(options.root, "api/environment.json"), "utf8");
  const workerPath = join(options.root, "worker/environment.json");
  const current = readFileSync(workerPath, "utf8");
  const legacy = JSON.parse(current);
  delete legacy.AUTH_ACCOUNTS_ENABLED;
  writeFileSync(workerPath, `${JSON.stringify(legacy)}\n`);
  initialize(options);
  assert.equal(readFileSync(workerPath, "utf8"), current);
  assert.equal(lstatSync(workerPath).mode & 0o777, 0o600);
  assert.equal(readRuntimeConfig(workerPath).AUTH_ACCOUNTS_ENABLED, "true");
  assert.equal(readFileSync(join(options.root, "installation.json"), "utf8"), state);
  assert.equal(readFileSync(join(options.root, "api/environment.json"), "utf8"), api);
  const changed = `${JSON.stringify({ ...legacy, AGENT_RUNTIME: "operator-choice" })}\n`;
  writeFileSync(workerPath, changed);
  assert.throws(() => initialize(options));
  assert.equal(readFileSync(workerPath, "utf8"), changed);
});

test("optional operator update configuration survives bootstrap without changing secrets", (t) => {
  const options = fixture(t);
  initialize(options);
  const installation = readFileSync(join(options.root, "installation.json"), "utf8");
  const environment = readFileSync(join(options.root, "api/environment.json"), "utf8");
  const path = join(options.root, "api/updates.json");
  const updateConfig = JSON.stringify({
    version: 1,
    installationId: "00000000-0000-4000-8000-000000000001",
    controllerAccountKey: "a".repeat(64),
    channel: "preview",
    adapter: {
      kind: "easypanel",
      deploymentTrigger: "https://panel.example.test/api/deploy/fixture-deploy-token",
    },
  });
  writeFileSync(path, updateConfig, { mode: 0o600 });
  initialize(options);
  assert.equal(readFileSync(path, "utf8"), updateConfig);
  assert.equal(readFileSync(join(options.root, "installation.json"), "utf8"), installation);
  assert.equal(readFileSync(join(options.root, "api/environment.json"), "utf8"), environment);
});

test("changed domain, missing state, and edited runtime files never rotate existing secrets", (t) => {
  const options = fixture(t);
  initialize(options);
  const state = readFileSync(join(options.root, "installation.json"), "utf8");
  assert.throws(() => initialize({ ...options, origin: "https://other.example.test" }));
  assert.equal(readFileSync(join(options.root, "installation.json"), "utf8"), state);
  const api = join(options.root, "api/environment.json");
  writeFileSync(api, "{}\n");
  assert.throws(() => initialize(options));
  assert.equal(readFileSync(api, "utf8"), "{}\n");
  rmSync(join(options.root, "installation.json"));
  assert.throws(() => initialize(options));
});

test("separate installations have distinct credentials and private network aliases", (t) => {
  const first = fixture(t);
  const second = fixture(t);
  initialize({ ...first, apiHost: "first-project-api-private" });
  initialize({ ...second, apiHost: "second-project-api-private" });
  const a = readRuntimeConfig(join(first.root, "api/environment.json"));
  const b = readRuntimeConfig(join(second.root, "api/environment.json"));
  assert.notEqual(a.DATABASE_URL, b.DATABASE_URL);
  assert.notEqual(a.ENCRYPTION_KEY, b.ENCRYPTION_KEY);
  assert.notEqual(a.BETTER_AUTH_SECRET, b.BETTER_AUTH_SECRET);
  assert.notEqual(a.ORKBOT_BOOTSTRAP_SECRET, b.ORKBOT_BOOTSTRAP_SECRET);
  assert.equal(
    readRuntimeConfig(join(first.root, "web/environment.json")).API_PROXY_TARGET,
    "http://first-project-api-private:3100",
  );
});

test("symlinks and public runtime files are refused", (t) => {
  const options = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside.root, join(options.root, "api"));
  assert.throws(() => initialize(options));
  rmSync(join(options.root, "api"));
  initialize(options);
  const api = join(options.root, "api/environment.json");
  chmodSync(api, 0o644);
  assert.throws(() => readRuntimeConfig(api));
  assert.throws(() => initialize(options));
});

test("empty Docker volume mountpoints are initialized without precreated secrets", (t) => {
  const options = fixture(t);
  for (const role of ["api", "worker", "web", "database", "migrate"])
    mkdirSync(join(options.root, role), { mode: 0o755 });
  initialize(options);
  assert.equal(readRuntimeConfig(join(options.root, "api/environment.json")).API_URL, origin);
});

test("runtime wrapper applies generated values and propagates exit status", (t) => {
  const options = fixture(t);
  initialize(options);
  const result = spawnSync(
    process.execPath,
    [
      new URL("./selfhost-runtime.mjs", import.meta.url).pathname,
      join(options.root, "web/environment.json"),
      process.execPath,
      "-e",
      "process.exit(process.env.API_PROXY_TARGET === 'http://ork-selfhost-api:3100' ? 17 : 1)",
    ],
    { env: { ...process.env, API_PROXY_TARGET: "http://wrong-service:3100" } },
  );
  assert.equal(result.status, 17);
  assert.equal(result.stderr.toString(), "");
});

test("only exact public HTTPS origins are accepted", () => {
  for (const input of [
    "http://server.example.test",
    `${origin}/`,
    `${origin}/path`,
    `${origin}?x=1`,
    "https://user:password@server.example.test",
    "https://SERVER.example.test",
    `${origin}:8443`,
  ])
    assert.throws(() => publicOrigin(input));
});
