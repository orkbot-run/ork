// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface PersonalRevocationScope {
  serverId: string;
  bindingVersion: number;
  keyFingerprint: string;
}
function scopeKey(scope: PersonalRevocationScope): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(scope.serverId) ||
    !Number.isSafeInteger(scope.bindingVersion) ||
    scope.bindingVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(scope.keyFingerprint)
  )
    throw new Error("Invalid personal revocation scope");
  return createHash("sha256")
    .update(JSON.stringify([scope.serverId, scope.bindingVersion, scope.keyFingerprint]))
    .digest("hex");
}
export interface PersonalRevocations {
  refuseInstallation(scope?: PersonalRevocationScope): Promise<void>;
  revoked(deviceId: string): Promise<boolean>;
  revoke(deviceIds: string[]): Promise<void>;
  restorationCheckpoint(scope?: PersonalRevocationScope): Promise<string[]>;
  confirmRestoration(checkpoint: readonly string[]): Promise<void>;
}
const marker = "revoked\n";
const restorationPrefix = ".restore-required.";
const restorationName = /^\.restore-required\.(?:binding\.[a-f0-9]{64}\.)?[a-zA-Z0-9]{12}$/;
/** Tombstones survive process restarts and a failed projection database transaction. */
export class FilePersonalRevocations implements PersonalRevocations {
  constructor(private readonly directory: string) {}
  async refuseInstallation(scope?: PersonalRevocationScope): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    const name = `${restorationPrefix}${scope ? `binding.${scopeKey(scope)}.` : ""}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const file = await open(
      path.join(this.directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile("pending\n");
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private file(deviceId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deviceId))
      throw new Error("Invalid personal device ID");
    return path.join(this.directory, deviceId);
  }
  private async checkDirectory(): Promise<void> {
    const stat = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("Personal revocation directory is unsafe");
  }
  /** Each restore adds a unique barrier. A request can clear only the barriers it observed. */
  async restorationCheckpoint(scope?: PersonalRevocationScope): Promise<string[]> {
    const key = scope ? scopeKey(scope) : undefined;
    await this.checkDirectory();
    const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const names = entries.filter((name) => name.startsWith(restorationPrefix)).sort();
    if (names.length > 128) throw new Error("Personal restoration verification is required");
    for (const name of names) {
      if (!restorationName.test(name)) throw new Error("Personal restoration marker is unsafe");
      const file = await open(
        path.join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== 8)
          throw new Error("Personal restoration marker is unreadable");
        const bytes = Buffer.alloc(9);
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== 8 || bytes.subarray(0, 8).toString("utf8") !== "pending\n")
          throw new Error("Personal restoration marker is unreadable");
      } finally {
        await file.close();
      }
    }
    return key
      ? names.filter(
          (name) =>
            !name.startsWith(`${restorationPrefix}binding.`) ||
            name.startsWith(`${restorationPrefix}binding.${key}.`),
        )
      : names;
  }
  async confirmRestoration(checkpoint: readonly string[]): Promise<void> {
    if (!checkpoint.length) return;
    await this.checkDirectory();
    for (const name of checkpoint) {
      if (!restorationName.test(name)) throw new Error("Personal restoration marker is unsafe");
      await unlink(path.join(this.directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async revoked(deviceId: string): Promise<boolean> {
    await this.checkDirectory();
    const file = await open(
      this.file(deviceId),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!file) return false;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== marker.length)
        throw new Error("Personal revocation marker is unreadable");
      const bytes = Buffer.alloc(marker.length + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      if (
        !stat.isFile() ||
        stat.size !== marker.length ||
        read.bytesRead !== marker.length ||
        bytes.subarray(0, read.bytesRead).toString("utf8") !== marker
      )
        throw new Error("Personal revocation marker is unreadable");
      return true;
    } finally {
      await file.close();
    }
  }
  async revoke(deviceIds: string[]): Promise<void> {
    if (!deviceIds.length) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    for (const id of deviceIds) {
      const destination = this.file(id);
      if (await this.revoked(id)) continue;
      const temporary = `${destination}.${randomUUID()}.tmp`;
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(marker);
        await file.sync();
        await file.close();
        await rename(temporary, destination);
      } finally {
        await file.close().catch(() => undefined);
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
