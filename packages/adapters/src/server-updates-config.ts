// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomBytes } from "node:crypto";
import {
  chownSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface ServerUpdatesConfig {
  version: 1;
  installationId: string;
  controllerAccountKey: string | null;
  channel: "stable" | "preview";
  adapter: { kind: "easypanel"; deploymentTrigger: string } | { kind: "standalone"; token: string };
}

const MAX_BYTES = 8192;
const invalid = () => new Error("Invalid private server update configuration.");
const exactKeys = (value: object, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** Keep the secret URL out of validation errors and diagnostics. */
export function validateDeploymentTrigger(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) throw invalid();
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/api\/(?:compose\/)?deploy\/[A-Za-z0-9_-]{16,256}$/.test(url.pathname) ||
      url.href !== input
    )
      throw invalid();
    return input;
  } catch {
    throw invalid();
  }
}

export function parseServerUpdatesConfig(input: unknown): ServerUpdatesConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const config = input as Record<string, unknown>;
  if (
    !exactKeys(config, [
      "version",
      "installationId",
      "controllerAccountKey",
      "channel",
      "adapter",
    ]) ||
    config.version !== 1 ||
    typeof config.installationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      config.installationId,
    ) ||
    !(
      config.controllerAccountKey === null ||
      (typeof config.controllerAccountKey === "string" &&
        /^[0-9a-f]{64}$/.test(config.controllerAccountKey))
    ) ||
    (config.channel !== "stable" && config.channel !== "preview") ||
    !config.adapter ||
    typeof config.adapter !== "object" ||
    Array.isArray(config.adapter)
  )
    throw invalid();
  const adapter = config.adapter as Record<string, unknown>;
  const checkedAdapter =
    adapter.kind === "easypanel" && exactKeys(adapter, ["kind", "deploymentTrigger"])
      ? {
          kind: "easypanel" as const,
          deploymentTrigger: validateDeploymentTrigger(adapter.deploymentTrigger),
        }
      : adapter.kind === "standalone" &&
          exactKeys(adapter, ["kind", "token"]) &&
          typeof adapter.token === "string" &&
          /^[A-Za-z0-9_-]{32,256}$/.test(adapter.token)
        ? { kind: "standalone" as const, token: adapter.token }
        : null;
  if (!checkedAdapter) throw invalid();
  if (config.controllerAccountKey === null && checkedAdapter.kind !== "standalone") throw invalid();
  return {
    version: 1,
    installationId: config.installationId,
    controllerAccountKey: config.controllerAccountKey as string | null,
    channel: config.channel,
    adapter: checkedAdapter,
  };
}

function privateDirectory(path: string, uid: number) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw invalid();
}

/** Missing is disabled; malformed, public, linked, or foreign-owned configuration fails closed. */
export function loadServerUpdatesConfig(
  path = "/run/orkbot/updates.json",
  uid = 1000,
): ServerUpdatesConfig | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw invalid();
  }
  try {
    privateDirectory(dirname(path), uid);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > MAX_BYTES
    )
      throw invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw invalid();
    return parseServerUpdatesConfig(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } catch {
    throw invalid();
  } finally {
    closeSync(fd);
  }
}

/** Explicit operator action only. Never modifies role environment, installation secrets, or volumes. */
export function configureServerUpdates({
  root,
  config: input,
  uid = 1000,
}: {
  root: string;
  config: unknown;
  uid?: number;
}): ServerUpdatesConfig {
  const config = parseServerUpdatesConfig(input);
  try {
    privateDirectory(root, uid);
    const path = join(root, "updates.json");
    const previous = loadServerUpdatesConfig(path, uid);
    if (
      previous &&
      (previous.installationId !== config.installationId ||
        previous.channel !== config.channel ||
        previous.controllerAccountKey !== config.controllerAccountKey)
    )
      throw invalid();
    const temporary = join(root, `.updates-${randomBytes(16).toString("hex")}.tmp`);
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        if (process.getuid?.() !== uid) chownSync(temporary, uid, uid);
        writeFileSync(fd, `${JSON.stringify(config)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, path);
      const directory = openSync(
        root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // A failed write already reports failure; cleanup must preserve that result.
      }
    }
    return config;
  } catch {
    throw invalid();
  }
}
