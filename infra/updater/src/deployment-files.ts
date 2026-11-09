// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readResponseWithin } from "@orkbot/core";

const allowed = new Set([
  "docker-compose.images.yml",
  "docker-compose.https.yml",
  "Caddyfile.prod",
]);
const digest = (contents: string) => createHash("sha256").update(contents).digest("hex");

/** Only unmodified installer templates can be replaced; operator overlays remain operator-owned. */
export async function stageDeploymentFiles(
  directory: string,
  revision: string,
  fetcher = globalThis.fetch,
) {
  const metadata = path.join(directory, ".orkbot-compose-state.json");
  const metadataStat = await lstat(metadata);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink())
    throw new Error("Invalid installation template manifest.");
  const previousMetadata = await readFile(metadata, "utf8");
  const manifest: { files: Record<string, string> } = JSON.parse(previousMetadata);
  if (
    !manifest.files ||
    !Object.hasOwn(manifest.files, "docker-compose.images.yml") ||
    Object.keys(manifest.files).some((name) => !allowed.has(name))
  )
    throw new Error("Invalid installation template manifest.");
  const originals = new Map<string, string>();
  const replacements = new Map<string, string>();
  for (const [name, expected] of Object.entries(manifest.files)) {
    const filename = path.join(directory, name);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Installation template is not a regular file.");
    const contents = await readFile(filename, "utf8");
    if (digest(contents) !== expected)
      throw new Error("Installation templates were changed by the operator.");
    originals.set(filename, contents);
    const signal = AbortSignal.timeout(15_000);
    const response = await fetcher(
      `https://raw.githubusercontent.com/orkbot-run/ork/${revision}/infra/compose/${name}`,
      { signal, redirect: "error" },
    );
    if (!response.ok) throw new Error("Could not download installation templates.");
    const bytes = await readResponseWithin(response, {
      maxBytes: 1_048_576,
      tooLargeMessage: "Installation template is too large.",
      signal,
    });
    const replacement = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (name === "Caddyfile.prod" && replacement !== contents)
      throw new Error("Proxy template changes require operator maintenance before updating.");
    replacements.set(filename, replacement);
  }
  const write = async (filename: string, contents: string) => {
    const temporary = `${filename}.${randomUUID()}.update-tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  const cleanup = async () => {
    for (const filename of originals.keys())
      await unlink(`${filename}.update-backup`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
  };
  const restore = async () => {
    for (const [filename, contents] of originals) await write(filename, contents);
    await write(metadata, previousMetadata);
    await cleanup();
  };
  return {
    async apply() {
      try {
        for (const [filename, contents] of replacements) {
          await writeFile(`${filename}.update-backup`, originals.get(filename)!, {
            mode: 0o600,
            flag: "wx",
          });
          await write(filename, contents);
        }
      } catch (error) {
        await restore();
        throw error;
      }
    },
    restore,
    async commit() {
      const files = Object.fromEntries(
        [...replacements].map(([filename, contents]) => [
          path.basename(filename),
          digest(contents),
        ]),
      );
      await write(metadata, `${JSON.stringify({ files })}\n`);
      await cleanup();
    },
  };
}

/** Finalize templates after an interrupted deployment only when every file matches its source. */
export async function reconcileDeploymentFiles(
  directory: string,
  revision: string,
  fetcher = globalThis.fetch,
): Promise<void> {
  const metadata = path.join(directory, ".orkbot-compose-state.json");
  const stat = await lstat(metadata);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Invalid installation template manifest.");
  const manifest: { files: Record<string, string> } = JSON.parse(await readFile(metadata, "utf8"));
  if (
    !manifest.files ||
    !Object.hasOwn(manifest.files, "docker-compose.images.yml") ||
    Object.keys(manifest.files).some((name) => !allowed.has(name))
  )
    throw new Error("Invalid installation template manifest.");
  const hashes: Record<string, string> = {};
  for (const [name, recorded] of Object.entries(manifest.files)) {
    const filename = path.join(directory, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid installation template.");
    const current = await readFile(filename, "utf8");
    const signal = AbortSignal.timeout(15_000);
    const response = await fetcher(
      `https://raw.githubusercontent.com/orkbot-run/ork/${revision}/infra/compose/${name}`,
      { signal, redirect: "error" },
    );
    if (!response.ok) throw new Error("Could not verify installation templates.");
    const expected = new TextDecoder("utf-8", { fatal: true }).decode(
      await readResponseWithin(response, {
        maxBytes: 1_048_576,
        tooLargeMessage: "Installation template is too large.",
        signal,
      }),
    );
    if (current !== expected)
      throw new Error("Installation templates do not match the running revision.");
    const currentHash = digest(current);
    if (recorded !== currentHash) {
      const backupPath = `${filename}.update-backup`;
      const backup = await lstat(backupPath);
      if (
        !backup.isFile() ||
        backup.isSymbolicLink() ||
        digest(await readFile(backupPath, "utf8")) !== recorded
      )
        throw new Error("Installation backup does not match the recorded template.");
    }
    hashes[name] = currentHash;
  }
  const temporary = `${metadata}.${randomUUID()}.reconcile-tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify({ files: hashes })}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, metadata);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  for (const name of Object.keys(hashes)) {
    await unlink(path.join(directory, `${name}.update-backup`)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }
}
