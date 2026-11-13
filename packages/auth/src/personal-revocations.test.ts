// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilePersonalRevocations } from "./personal-revocations.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ork-personal-revocations-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("personal revocation journal", () => {
  it("retains late binding refusals without blocking another binding, key or server", async () => {
    const directory = await fixture();
    const journal = new FilePersonalRevocations(directory);
    const scope = { serverId: randomUUID(), bindingVersion: 1, keyFingerprint: "a".repeat(64) };
    const next = { ...scope, bindingVersion: 2 };
    await journal.refuseInstallation(scope);
    const old = await journal.restorationCheckpoint(scope);
    expect(old).toHaveLength(1);
    expect(await journal.restorationCheckpoint(next)).toEqual([]);
    expect(
      await journal.restorationCheckpoint({ ...scope, keyFingerprint: "b".repeat(64) }),
    ).toEqual([]);
    expect(await journal.restorationCheckpoint({ ...scope, serverId: randomUUID() })).toEqual([]);
    await journal.refuseInstallation();
    const global = await journal.restorationCheckpoint(next);
    expect(global).toHaveLength(1);
    expect(await journal.restorationCheckpoint(scope)).toHaveLength(2);
    await journal.confirmRestoration(global);
    expect(await journal.restorationCheckpoint(next)).toEqual([]);
    expect(await journal.restorationCheckpoint(scope)).toEqual(old);
    expect(await readdir(directory)).toEqual(old);
  });
  it.skipIf(process.platform === "win32")(
    "preserves scoped evidence and a global restore barrier through the actual helper",
    async () => {
      const source = await fixture();
      const destination = await fixture();
      const journal = new FilePersonalRevocations(
        path.join(source, "identity/personal-revocations"),
      );
      const scope = { serverId: randomUUID(), bindingVersion: 1, keyFingerprint: "a".repeat(64) };
      const next = { ...scope, bindingVersion: 2 };
      const device = randomUUID();
      await journal.refuseInstallation(scope);
      await journal.revoke([device]);
      const original = await journal.restorationCheckpoint(scope);
      execFileSync(
        "/bin/bash",
        [
          path.resolve(import.meta.dirname, "../../../scripts/preserve-personal-revocations.sh"),
          source,
          destination,
        ],
        { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
      );
      const restored = new FilePersonalRevocations(
        path.join(destination, "identity/personal-revocations"),
      );
      expect(await restored.revoked(device)).toBe(true);
      const current = await restored.restorationCheckpoint(next);
      expect(current).toHaveLength(1);
      expect(await restored.restorationCheckpoint(scope)).toHaveLength(2);
      await restored.confirmRestoration(current);
      expect(await restored.restorationCheckpoint(next)).toEqual([]);
      expect(await restored.restorationCheckpoint(scope)).toEqual(original);
      expect(await restored.revoked(device)).toBe(true);
    },
  );

  it("persists a whole-installation refusal before device IDs can be read from the database", async () => {
    const directory = await fixture();
    const journal = new FilePersonalRevocations(directory);
    await journal.refuseInstallation();
    const checkpoint = await new FilePersonalRevocations(directory).restorationCheckpoint();
    expect(checkpoint).toHaveLength(1);
    await journal.refuseInstallation();
    await journal.confirmRestoration(checkpoint);
    expect(await new FilePersonalRevocations(directory).restorationCheckpoint()).toHaveLength(1);
  });
  it.skipIf(process.platform === "win32")(
    "recognizes and confirms the barrier written by the actual restore helper",
    async () => {
      const source = await fixture();
      const destination = await fixture();
      const sourceJournal = path.join(source, "identity/personal-revocations");
      await mkdir(sourceJournal, { recursive: true });
      const id = randomUUID();
      await writeFile(path.join(sourceJournal, id), "revoked\n");
      execFileSync(
        "/bin/bash",
        [
          path.resolve(import.meta.dirname, "../../../scripts/preserve-personal-revocations.sh"),
          source,
          destination,
        ],
        {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        },
      );
      const journal = new FilePersonalRevocations(
        path.join(destination, "identity/personal-revocations"),
      );
      const checkpoint = await journal.restorationCheckpoint();
      expect(checkpoint).toHaveLength(1);
      expect(await journal.revoked(id)).toBe(true);
      await journal.confirmRestoration(checkpoint);
      expect(await journal.restorationCheckpoint()).toEqual([]);
      expect(await journal.revoked(id)).toBe(true);
    },
  );
  it("clears only restoration barriers observed before a fresh verification", async () => {
    const directory = await fixture();
    const journal = new FilePersonalRevocations(directory);
    const first = ".restore-required.aaaaaaaaaaaa";
    const second = ".restore-required.bbbbbbbbbbbb";
    expect(await journal.restorationCheckpoint()).toEqual([]);
    await writeFile(path.join(directory, first), "pending\n", { mode: 0o600 });
    const checkpoint = await journal.restorationCheckpoint();
    await writeFile(path.join(directory, second), "pending\n", { mode: 0o600 });
    const id = randomUUID();
    await journal.revoke([id]);
    await Promise.all([
      journal.confirmRestoration(checkpoint),
      journal.confirmRestoration(checkpoint),
    ]);
    expect(await new FilePersonalRevocations(directory).restorationCheckpoint()).toEqual([second]);
    await journal.confirmRestoration([second]);
    expect(await journal.restorationCheckpoint()).toEqual([]);
    expect(await journal.revoked(id)).toBe(true);
  });
  it.each(["invalid name", "invalid contents", "directory"])(
    "fails closed for a restoration marker with %s",
    async (kind) => {
      const directory = await fixture();
      const file = path.join(
        directory,
        kind === "invalid name" ? ".restore-required.invalid" : ".restore-required.aaaaaaaaaaaa",
      );
      if (kind === "directory") await mkdir(file);
      else await writeFile(file, kind === "invalid contents" ? "pending\n\n" : "pending\n");
      await expect(
        new FilePersonalRevocations(directory).restorationCheckpoint(),
      ).rejects.toThrow();
      await expect(
        new FilePersonalRevocations(directory).confirmRestoration(["../outside"]),
      ).rejects.toThrow("unsafe");
    },
  );
  it.skipIf(process.platform === "win32")(
    "does not follow a linked restoration marker",
    async () => {
      const directory = await fixture();
      const outside = await fixture();
      const target = path.join(outside, "untouched");
      await writeFile(target, "pending\n");
      await symlink(target, path.join(directory, ".restore-required.aaaaaaaaaaaa"));
      await expect(
        new FilePersonalRevocations(directory).restorationCheckpoint(),
      ).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("pending\n");
    },
  );
  it("retains concurrent tombstones across restart without leaving partial files", async () => {
    const directory = await fixture();
    const first = new FilePersonalRevocations(directory);
    const id = randomUUID();
    expect(await first.revoked(id)).toBe(false);
    await Promise.all(
      Array.from({ length: 12 }, () => new FilePersonalRevocations(directory).revoke([id])),
    );
    expect(await new FilePersonalRevocations(directory).revoked(id)).toBe(true);
    expect(await readdir(directory)).toEqual([id]);
    if (process.platform !== "win32")
      expect((await stat(path.join(directory, id))).mode & 0o777).toBe(0o600);
  });
  it("refuses a corrupted marker instead of restoring permission", async () => {
    const directory = await fixture();
    const id = randomUUID();
    await writeFile(path.join(directory, id), "");
    const journal = new FilePersonalRevocations(directory);
    await expect(journal.revoked(id)).rejects.toThrow("unreadable");
    await expect(journal.revoke([id])).rejects.toThrow("unreadable");
  });
  it.skipIf(process.platform === "win32")(
    "never follows a linked marker or directory",
    async () => {
      const directory = await fixture();
      const outside = await fixture();
      const id = randomUUID();
      const destination = path.join(outside, "untouched");
      await writeFile(destination, "private fixture");
      await symlink(destination, path.join(directory, id));
      await expect(new FilePersonalRevocations(directory).revoked(id)).rejects.toThrow();
      await expect(new FilePersonalRevocations(directory).revoke([id])).rejects.toThrow();
      expect(await readFile(destination, "utf8")).toBe("private fixture");
      const link = path.join(directory, "linked-directory");
      await symlink(outside, link);
      await expect(new FilePersonalRevocations(link).revoke([randomUUID()])).rejects.toThrow(
        "unsafe",
      );
      expect(await readdir(outside)).toEqual(["untouched"]);
    },
  );
  it("rejects traversal before creating a marker", async () => {
    const directory = await fixture();
    await expect(new FilePersonalRevocations(directory).revoke(["../outside"])).rejects.toThrow(
      "Invalid",
    );
    expect(await readdir(directory)).toEqual([]);
  });
});
