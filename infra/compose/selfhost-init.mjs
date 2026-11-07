// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SECRET_KEYS = [
  "databaseOwner",
  "databaseApp",
  "encryption",
  "session",
  "screen",
  "bootstrap",
];
const VERSION = 1;
class ConfigurationError extends Error {}

export function publicOrigin(input) {
  const url = new URL(input);
  if (
    input !== url.origin ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ConfigurationError("Set PUBLIC_ORIGIN to the server's exact public HTTPS origin.");
  return url;
}

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid?.() !== 0 && stat.uid !== process.getuid?.())
  )
    throw new ConfigurationError(
      "Self-host configuration directories must be private regular directories.",
    );
  chmodSync(path, 0o700);
}

function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32_768 || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)
      throw new ConfigurationError("Invalid saved self-host configuration.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function save(path, value, uid) {
  if (exists(path)) {
    if (read(path) !== value)
      throw new ConfigurationError("Existing self-host configuration differs; it was kept.");
    return;
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (uid !== undefined) chownSync(temporary, uid, uid);
  renameSync(temporary, path);
}

/** Initialization is serialized by Compose; persisted state makes interrupted runs resumable. */
export function initialize({
  root,
  origin,
  serviceHost = "ork-selfhost-database",
  apiHost = "ork-selfhost-api",
  uid,
  dataDirectory,
}) {
  const url = publicOrigin(origin);
  if (
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(serviceHost) ||
    !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(apiHost)
  )
    throw new ConfigurationError("Invalid self-host internal service name.");
  directory(root);
  const stateFile = join(root, "installation.json");
  let state;
  if (exists(stateFile)) {
    state = JSON.parse(read(stateFile));
    if (
      state?.version !== VERSION ||
      state.origin !== origin ||
      state.serviceHost !== serviceHost ||
      state.apiHost !== apiHost ||
      !state.secrets ||
      SECRET_KEYS.some((key) => !/^[A-Za-z0-9_-]{43}$/.test(state.secrets[key] ?? ""))
    )
      throw new ConfigurationError(
        "The saved self-host installation does not match this configuration; it was kept.",
      );
  } else {
    // Never silently regenerate secrets beside existing runtime configuration.
    if (
      ["api", "worker", "web", "migrate"].some((role) =>
        exists(join(root, role, "environment.json")),
      ) ||
      exists(join(root, "database", "password"))
    )
      throw new ConfigurationError(
        "Self-host runtime configuration exists without its installation state; it was kept.",
      );
    state = {
      version: VERSION,
      origin,
      serviceHost,
      apiHost,
      secrets: Object.fromEntries(
        SECRET_KEYS.map((key) => [key, randomBytes(32).toString("base64url")]),
      ),
    };
    save(stateFile, `${JSON.stringify(state)}\n`);
  }
  const secret = state.secrets;
  const database = `postgres://rakazo_app:${secret.databaseApp}@${serviceHost}:5432/orkbot`;
  const shared = {
    NODE_ENV: "production",
    DATABASE_URL: database,
    DATA_DIR: "/data",
    ENCRYPTION_KEY: Buffer.from(secret.encryption, "base64url").toString("hex"),
    CONTENT_ENCRYPTION: "on",
    SECRET_STORE: "encrypted",
    WAKEUP_DRIVER: "graphile",
    AGENT_RUNTIME: "pi",
    API_URL: origin,
    SANDBOX_PROVIDER: "none",
    CLOUD_AGENT_PROVIDER: "none",
    PAYMENT_WALLET_PROVIDER: "none",
  };
  const roles = {
    api: {
      ...shared,
      API_HOST: "0.0.0.0",
      API_PORT: "3100",
      BETTER_AUTH_URL: origin,
      WEB_ORIGIN: origin,
      BETTER_AUTH_SECRET: secret.session,
      SCREEN_PROXY_SECRET: secret.screen,
      AUTH_PASSWORD_ENABLED: "false",
      AUTH_ACCOUNTS_ENABLED: "true",
      SIGNUPS_ENABLED: "false",
      ORKBOT_BOOTSTRAP_SECRET: secret.bootstrap,
    },
    worker: shared,
    web: {
      NODE_ENV: "production",
      ORKBOT_HOST: url.hostname,
      API_PROXY_TARGET: `http://${apiHost}:3100`,
      SCREEN_PROXY_SECRET: secret.screen,
    },
    migrate: {
      DATABASE_URL: database,
      DATABASE_MIGRATION_URL: `postgres://orkbot:${secret.databaseOwner}@${serviceHost}:5432/orkbot`,
    },
  };
  for (const [role, values] of Object.entries(roles)) {
    const path = join(root, role);
    directory(path);
    save(join(path, "environment.json"), `${JSON.stringify(values)}\n`, uid);
    if (uid !== undefined) chownSync(path, uid, uid);
  }
  const databaseDirectory = join(root, "database");
  directory(databaseDirectory);
  save(join(databaseDirectory, "password"), `${secret.databaseOwner}\n`);
  chmodSync(databaseDirectory, 0o700);
  if (dataDirectory) {
    directory(dataDirectory);
    if (uid !== undefined) chownSync(dataDirectory, uid, uid);
  }
  return { origin, bootstrapSecret: secret.bootstrap };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const result = initialize({
      root: "/configuration",
      origin: process.argv[2],
      apiHost: process.argv[3],
      uid: process.getuid?.() === 0 ? 1000 : undefined,
      dataDirectory: "/data",
    });
    const link = new URL("orkbot://initialize");
    link.searchParams.set("server", result.origin);
    link.searchParams.set("secret", result.bootstrapSecret);
    process.stdout.write(`Open in Ork to initialize this server:\n${link.href}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof ConfigurationError ? error.message : "Could not initialize self-host configuration."}\n`,
    );
    process.exitCode = 1;
  }
}
