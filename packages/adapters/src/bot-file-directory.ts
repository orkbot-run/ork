// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited workspace containment patterns are preserved; bounded transfer is an Ork addition.

import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type { AdapterContext, DirectoryExportLimits, PortableFile } from "@orkbot/adapter-kit";

async function openedPath(fd: number): Promise<string> {
  if (process.platform === "linux") return readlink(`/proc/self/fd/${fd}`);
  const { fileHandlePath } = await import("./file-handle-path.js");
  return fileHandlePath(fd);
}

const contained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};

/** Bind containment and size checks to the opened object, including files that grow. */
export async function readLocalBotFile(
  workspace: string,
  requested: string,
  context: Pick<AdapterContext, "signal">,
  maxBytes: number,
  rejectHardLinks = false,
): Promise<Uint8Array> {
  context.signal.throwIfAborted();
  const root = await realpath(workspace);
  const file = await open(
    requested,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (rejectHardLinks && info.nlink !== 1) ||
      !contained(root, await openedPath(file.fd))
    )
      throw new Error("File is not a regular contained file");
    if (info.size > maxBytes) throw new Error("File exceeds the byte limit");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      context.signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
      const { bytesRead } = await file.read(chunk);
      context.signal.throwIfAborted();
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error("File exceeds the byte limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

/** Read an already authorized local directory without following links or collecting its listing. */
export async function* exportLocalBotDirectory(
  workspace: string,
  requested: string,
  context: AdapterContext,
  limits: DirectoryExportLimits,
): AsyncGenerator<PortableFile> {
  if (process.platform !== "linux")
    throw new Error("Bounded directory transfer is unsupported on this platform");
  const workspaceRoot = await realpath(workspace);
  if ((await lstat(requested)).isSymbolicLink()) throw new Error("Directory links are unsupported");
  const root = await realpath(requested);
  if (!contained(workspaceRoot, root)) throw new Error("Directory escapes the computer workspace");
  const counts = { entries: 0, bytes: 0, metadata: 0 };
  async function* walk(
    directory: string,
    relative: string,
    depth: number,
  ): AsyncGenerator<PortableFile> {
    context.signal.throwIfAborted();
    if (depth > limits.maxDepth) throw new Error("Directory exceeds the depth limit");
    const handle = await open(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if (!contained(root, await openedPath(handle.fd)))
        throw new Error("Directory escapes its source");
      const anchored = `/proc/self/fd/${handle.fd}`;
      const entries = await opendir(anchored);
      for await (const entry of entries) {
        context.signal.throwIfAborted();
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (++counts.entries > limits.maxFiles)
          throw new Error("Directory exceeds the entry limit");
        counts.metadata += Buffer.byteLength(name) + 64;
        if (Buffer.byteLength(name) > 4096 || counts.metadata > limits.maxMetadataBytes)
          throw new Error("Directory exceeds the metadata limit");
        const candidate = path.join(anchored, entry.name);
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          throw new Error("Directory contains an unsupported link or special file");
        if (info.isDirectory()) {
          yield* walk(candidate, name, depth + 1);
          continue;
        }
        const content = await readLocalBotFile(
          root,
          candidate,
          context,
          limits.maxBytes - counts.bytes,
          true,
        );
        counts.bytes += content.byteLength;
        yield { path: name, content };
      }
    } finally {
      await handle.close();
    }
  }
  yield* walk(root, "", 0);
}
