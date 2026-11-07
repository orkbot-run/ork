// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type * as FsPromises from "node:fs/promises";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((target: string) => Promise<void>) | undefined,
  beforeList: undefined as (() => Promise<void>) | undefined,
  grew: false,
  growPath: "",
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      await hooks.beforeOpen?.(String(args[0]));
      const handle = await fs.open(...args);
      if (String(args[0]) === hooks.growPath) {
        const originalStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const info = await originalStat();
          await fs.appendFile(hooks.growPath, "grew-after-stat");
          hooks.grew = true;
          return info;
        });
      }
      return handle;
    },
    opendir: async (target: string) => {
      await hooks.beforeList?.();
      return fs.opendir(target);
    },
  };
});

import { exportLocalBotDirectory, readLocalBotFile } from "./bot-file-directory.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

const roots: string[] = [];
const context = {
  spaceId: "space",
  userId: "user",
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};
const limits = { maxBytes: 1024, maxFiles: 256, maxDepth: 16, maxMetadataBytes: 256 * 1024 };
async function root() {
  const value = await mkdtemp(path.join(tmpdir(), "ork-bot-directory-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  hooks.beforeOpen = undefined;
  hooks.beforeList = undefined;
  hooks.growPath = "";
  hooks.grew = false;
  vi.restoreAllMocks();
  for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true });
});

it("caps actual bytes when the opened regular file grows after its size check", async () => {
  const dir = await root();
  const file = path.join(dir, "grow.txt");
  await writeFile(file, "a");
  hooks.growPath = file;
  await expect(readLocalBotFile(dir, file, context, 2)).rejects.toThrow(
    "computer file exceeds 2 bytes",
  );
  expect(hooks.grew).toBe(true);
});

it("rejects a single hardlinked transfer while preserving ordinary read semantics", async () => {
  const dir = await root();
  const provider = new DesktopSandboxProvider({ root: dir });
  const computer = await provider.provision({ botId: "fixture", homePath: "unused" }, context);
  const outside = path.join(dir, "outside.txt");
  await writeFile(outside, "private fixture");
  await link(outside, path.join(computer.providerRef, "hard.txt"));
  await expect(provider.readTransferFile(computer, "hard.txt", context, 1024)).rejects.toThrow(
    "regular contained",
  );
  expect(new TextDecoder().decode(await provider.readFile(computer, "hard.txt", context))).toBe(
    "private fixture",
  );
});

it("binds transfer containment to the opened file after a parent path swap", async () => {
  const dir = await root();
  const outside = await root();
  const nested = path.join(dir, "nested");
  const file = path.join(nested, "file.txt");
  await mkdir(nested);
  await writeFile(file, "inside");
  await writeFile(path.join(outside, "file.txt"), "outside");
  hooks.beforeOpen = async (target) => {
    if (target !== file) return;
    hooks.beforeOpen = undefined;
    await rename(nested, `${nested}-old`);
    await symlink(outside, nested);
  };
  await expect(readLocalBotFile(dir, file, context, 1024, true)).rejects.toThrow(
    "regular contained",
  );
});

it.runIf(process.platform !== "linux")(
  "refuses directory enumeration on platforms without fd-anchored directory IO",
  async () => {
    const dir = await root();
    await expect(collect(exportLocalBotDirectory(dir, dir, context, limits))).rejects.toThrow(
      "unsupported on this platform",
    );
  },
);

it.runIf(process.platform === "linux")(
  "exports only the selected directory with real fd-anchored IO",
  async () => {
    const dir = await root();
    await mkdir(path.join(dir, "selected"));
    await writeFile(path.join(dir, "selected", "file.txt"), "inside");
    await writeFile(path.join(dir, "outside.txt"), "outside");
    const files = await collect(
      exportLocalBotDirectory(dir, path.join(dir, "selected"), context, limits),
    );
    expect(files.map((file) => [file.path, new TextDecoder().decode(file.content)])).toEqual([
      ["file.txt", "inside"],
    ]);
  },
);

it.runIf(process.platform === "linux")(
  "anchors both descendant enumeration and file resolution after a directory swap",
  async () => {
    const dir = await root();
    const outside = await root();
    const nested = path.join(dir, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "file.txt"), "inside");
    await writeFile(path.join(outside, "file.txt"), "outside");
    let calls = 0;
    hooks.beforeList = async () => {
      if (++calls !== 2) return;
      await rename(nested, `${nested}-old`);
      await symlink(outside, nested);
    };
    const files = await collect(exportLocalBotDirectory(dir, dir, context, limits));
    expect(files.map((file) => new TextDecoder().decode(file.content))).toEqual(["inside"]);
  },
);

it.runIf(process.platform === "linux").each([
  { maxFiles: 0, message: "entry limit" },
  { maxBytes: 0, message: "computer file exceeds 0 bytes" },
  { maxMetadataBytes: 0, message: "metadata limit" },
])("rejects directory resource overflow: $message", async (cap) => {
  const dir = await root();
  await writeFile(path.join(dir, "file.txt"), "inside");
  await expect(
    collect(exportLocalBotDirectory(dir, dir, context, { ...limits, ...cap })),
  ).rejects.toThrow(cap.message);
});

it.runIf(process.platform === "linux")(
  "rejects symlinks instead of reading another directory",
  async () => {
    const dir = await root();
    const outside = await root();
    await writeFile(path.join(outside, "private.txt"), "outside");
    await symlink(outside, path.join(dir, "linked"));
    await expect(collect(exportLocalBotDirectory(dir, dir, context, limits))).rejects.toThrow(
      "unsupported link",
    );
  },
);
