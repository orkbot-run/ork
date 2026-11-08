// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { resolveSupervisorToken } from "@orkbot/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BOT_FILE_TRANSFER_SCRIPT } from "./bot-file-transfer.js";

const mock = vi.hoisted(() => ({ exec: vi.fn(), inspect: vi.fn() }));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
  },
}));

import { supervisorApp } from "./index.js";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(path.join(tmpdir(), "ork-file-transfer-"));
  roots.push(root);
  return root;
}
function read(root: string, relative: string, limit = 100, script = BOT_FILE_TRANSFER_SCRIPT) {
  return spawnSync("python3", ["-c", script, root, relative, String(limit), "0"], {
    encoding: "utf8",
    timeout: 2_000,
  });
}
beforeEach(() => {
  mock.exec.mockReset();
  mock.inspect.mockResolvedValue({
    Config: {
      Labels: { "orkbot.managed": "true", "orkbot.botId": "home", "orkbot.spaceId": "space" },
    },
  });
  mock.exec.mockImplementation(async () => ({
    start: async () =>
      Duplex.from({
        readable: Readable.from([Buffer.from("Ynl0ZXM=")]),
        writable: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
      }),
    inspect: async () => ({ ExitCode: 0 }),
  }));
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reads exact regular-file bytes in a controlled local filesystem", () => {
  const root = directory();
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "nested", "file.txt"), Buffer.from([0, 1, 128, 255]));
  const result = read(root, "nested/file.txt", 4);
  expect(result.status).toBe(0);
  expect(Buffer.from(result.stdout, "base64")).toEqual(Buffer.from([0, 1, 128, 255]));
});

it.each(["symlink", "hardlink", "fifo", "directory", "parent-symlink"])(
  "rejects a %s before reading content or blocking",
  (kind) => {
    const root = directory();
    const outside = directory();
    writeFileSync(path.join(outside, "private.txt"), "outside-fixture");
    if (kind === "symlink")
      symlinkSync(path.join(outside, "private.txt"), path.join(root, "source"));
    if (kind === "hardlink") linkSync(path.join(outside, "private.txt"), path.join(root, "source"));
    if (kind === "fifo") expect(spawnSync("mkfifo", [path.join(root, "source")]).status).toBe(0);
    if (kind === "directory") mkdirSync(path.join(root, "source"));
    if (kind === "parent-symlink") symlinkSync(outside, path.join(root, "source"));
    const result = read(root, kind === "parent-symlink" ? "source/private.txt" : "source");
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  },
);

it("caps actual reads when a file grows after fstat", () => {
  const root = directory();
  writeFileSync(path.join(root, "growing.txt"), "a");
  const script = BOT_FILE_TRANSFER_SCRIPT.replace(
    "chunks, total = [], 0",
    "os.write(os.open(os.path.join(root, relative), os.O_WRONLY | os.O_APPEND), b'growth')\n    chunks, total = [], 0",
  );
  const result = read(root, "growing.txt", 2, script);
  expect(result.status).toBe(42);
  expect(result.stdout).toBe("");
});

it("retires the real helper on stdin EOF during pending work", async () => {
  const script = BOT_FILE_TRANSFER_SCRIPT.replace(
    "parts = relative.split('/')",
    "sys.stderr.write('READY\\n'); sys.stderr.flush()\n__import__('time').sleep(60)\nparts = relative.split('/')",
  );
  const child = spawn("python3", ["-c", script, directory(), "file", "10", "1"]);
  try {
    const ready = new Promise<void>((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        if (String(chunk).includes("READY")) resolve();
      });
      child.once("error", reject);
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    await ready;
    child.stdin.end();
    expect(await exited).toBe(125);
  } finally {
    child.kill("SIGKILL");
  }
});

function request(signal?: AbortSignal) {
  return supervisorApp.request("/computers/computer/files/transfer?path=file.txt&maxBytes=100", {
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "x-orkbot-bot-id": "home",
      "x-orkbot-space-id": "space",
    },
    signal,
  });
}
it("runs the transfer mode with the process-tree deadline and stdin cancellation", async () => {
  expect(await (await request()).json()).toEqual({ content: "Ynl0ZXM=" });
  expect(mock.exec).toHaveBeenCalledWith(
    expect.objectContaining({
      AttachStdin: true,
      Cmd: expect.arrayContaining([
        "timeout",
        "--kill-after=1s",
        "25s",
        BOT_FILE_TRANSFER_SCRIPT,
        "/home/orkbot",
        "file.txt",
        "100",
        "1",
      ]),
    }),
  );
});

it("closes the helper input when the HTTP request is cancelled", async () => {
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  mock.exec.mockResolvedValue({
    start: async () => stream,
    inspect: async () => ({ ExitCode: 0 }),
  });
  const controller = new AbortController();
  const response = request(controller.signal);
  await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledOnce());
  controller.abort(new Error("fixture cancelled"));
  await response;
  expect(stream.destroyed).toBe(true);
});
