// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sourcePath = path.join(
  path.dirname(require.resolve("expo/package.json")),
  "src/async-require/messageSocket.native.ts",
);
const { outputText } = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  fileName: sourcePath,
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
});

function loadSocketModule({
  dev = true,
  bundleLoadedFromServer = true,
  url = "http://localhost:8081/",
  listeners,
}: {
  dev?: boolean;
  bundleLoadedFromServer?: boolean;
  url?: string;
  listeners?: Array<() => unknown>;
} = {}) {
  const connections: string[] = [];
  const sockets: Array<{ onmessage?: (message: { data: string }) => void }> = [];
  const getDevServer = vi.fn(() => ({ bundleLoadedFromServer, url }));
  class Socket {
    onmessage?: (message: { data: string }) => void;
    constructor(address: string) {
      connections.push(address);
      sockets.push(this);
    }
  }
  runInNewContext(
    outputText,
    {
      __DEV__: dev,
      __EXPO_RSC_RELOAD_LISTENERS__: listeners,
      exports: {},
      process: { env: { EXPO_OS: "ios" } },
      URL,
      WebSocket: Socket,
      require: (specifier: string) => {
        if (specifier !== "./getDevServer") throw new Error(`Unexpected import: ${specifier}`);
        return getDevServer;
      },
    },
    { filename: sourcePath },
  );
  return { connections, sockets, getDevServer };
}

function command(platform?: string) {
  return {
    data: JSON.stringify({ method: "sendDevCommand", params: { name: "rsc-reload", platform } }),
  };
}

describe("Expo optional development socket", () => {
  it("loads an embedded debug bundle without opening a socket or parsing a server URL", () => {
    const loaded = loadSocketModule({ bundleLoadedFromServer: false, url: "" });
    expect(loaded.connections).toEqual([]);
    expect(loaded.getDevServer).toHaveBeenCalledOnce();
  });

  it.each([
    ["http://localhost:8081/", "ws://localhost:8081/message"],
    ["https://metro.example.test:8082/", "wss://metro.example.test:8082/message"],
  ])("connects a Metro bundle from %s through %s", (url, expected) => {
    const loaded = loadSocketModule({ url });
    expect(loaded.connections).toEqual([expected]);
    expect(loaded.getDevServer).toHaveBeenCalledOnce();
  });

  it("keeps RSC reload listeners and ignores commands for another platform", () => {
    const listeners = [vi.fn(), vi.fn()];
    const { sockets } = loadSocketModule({ listeners });
    const socket = sockets[0]!;
    socket.onmessage?.(command("android"));
    for (const listener of listeners) expect(listener).not.toHaveBeenCalled();
    socket.onmessage?.(command("ios"));
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();
    socket.onmessage?.(command());
    for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(2);
  });

  it("allows a server-only module without RSC reload listeners", () => {
    const { sockets } = loadSocketModule();
    expect(() => sockets[0]?.onmessage?.(command())).not.toThrow();
  });

  it("does not inspect the development server or create a socket in production", () => {
    const loaded = loadSocketModule({ dev: false });
    expect(loaded.getDevServer).not.toHaveBeenCalled();
    expect(loaded.connections).toEqual([]);
  });
});
