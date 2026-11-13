// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
