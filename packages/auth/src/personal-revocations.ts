// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface PersonalRevocations {
  revoked(deviceId: string): Promise<boolean>;
  revoke(deviceIds: string[]): Promise<void>;
}
const marker = "revoked\n";
/** Tombstones survive process restarts and a failed projection database transaction. */
export class FilePersonalRevocations implements PersonalRevocations {
  constructor(private readonly directory: string) {}
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
