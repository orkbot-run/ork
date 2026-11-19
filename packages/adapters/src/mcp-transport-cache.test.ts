// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { McpSession } from "./mcp-transport.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

async function connected() {
  const session = new McpSession();
  await session.connectRemote({
    url: "https://mcp.example.test/mcp",
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = await request.json();
        if (message.method !== "initialize") return new Response(null, { status: 202 });
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1" },
          },
        });
      },
    },
  });
  return session;
}

async function changed(session: McpSession) {
  session.client.transport?.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
  });
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("live MCP session tool catalog", () => {
  it("reuses complete paginated discovery and protects it from caller mutation", async () => {
    const session = await connected();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockResolvedValueOnce({ tools: [tool("first")], nextCursor: "second" })
      .mockResolvedValueOnce({ tools: [tool("second")] });
    try {
      const first = await session.listTools();
      first.tools[0]!.name = "mutated";
      const second = await session.listTools({ discoveryLimits: { maxTools: 250 } });
      expect(second.tools.map((entry) => entry.name)).toEqual(["first", "second"]);
      expect(list).toHaveBeenCalledTimes(2);
      second.tools.pop();
      expect((await session.listTools()).tools).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it("does not cache partial catalogs and keeps discovery limits isolated", async () => {
    const session = await connected();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockResolvedValue({ tools: [tool("first"), tool("second")] });
    try {
      for (let i = 0; i < 2; i += 1) {
        expect(
          (await session.listTools({ discoveryLimits: { maxTools: 1 } })).diagnostic?.reason,
        ).toBe("tool_limit");
      }
      expect(list).toHaveBeenCalledTimes(2);
      expect((await session.listTools()).tools).toHaveLength(2);
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(3);
      await session.listTools({ discoveryLimits: { maxBytes: 1 } });
      expect(list).toHaveBeenCalledTimes(4);
    } finally {
      await session.close();
    }
  });

  it("invalidates on server notification and explicit diagnostics", async () => {
    const session = await connected();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockResolvedValue({ tools: [tool("first")] });
    try {
      await session.listTools();
      await changed(session);
      await session.listTools();
      await session.listTools({ fresh: true });
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      await session.close();
    }
  });

  it("never serves or caches an in-flight result overtaken by list_changed", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("new")] });
    try {
      const listing = session.listTools();
      await changed(session);
      pending.resolve({ tools: [tool("old")] });
      expect((await listing).tools).toEqual([tool("new")]);
      expect((await session.listTools()).tools).toEqual([tool("new")]);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("does not resurrect discovery after closing its session", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    vi.spyOn(session.client, "listTools").mockReturnValue(pending.promise);
    const listing = session.listTools();
    const rejected = expect(listing).rejects.toThrow("not connected");
    await session.close();
    pending.resolve({ tools: [tool("old")] });
    await rejected;
    await expect(session.listTools()).rejects.toThrow("not connected");
  });

  it("keeps cancellation local to a caller, including cache hits", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("current")] });
    try {
      const controller = new AbortController();
      const cancelled = session.listTools({ signal: controller.signal });
      const rejected = expect(cancelled).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      expect((await session.listTools()).tools).toEqual([tool("current")]);
      pending.resolve({ tools: [tool("obsolete")] });
      await rejected;
      expect((await session.listTools()).tools).toEqual([tool("current")]);
      await expect(session.listTools({ signal: controller.signal })).rejects.toThrow("cancelled");
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("invalidates unknown-tool errors without retrying tool side effects", async () => {
    const session = await connected();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockResolvedValue({ tools: [tool("first")] });
    const call = vi
      .spyOn(session.client, "callTool")
      .mockRejectedValue(new McpError(ErrorCode.InvalidParams, "Unknown tool"));
    try {
      await session.listTools();
      await expect(session.callTool("first")).rejects.toThrow("Unknown tool");
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(2);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it("invalidates credential changes during discovery", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("new-grant")] });
    try {
      const listing = session.listTools();
      session.invalidateToolCatalog();
      pending.resolve({ tools: [tool("old-grant")] });
      expect((await listing).tools).toEqual([tool("new-grant")]);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("rejects retired discovery while allowing a running tool to finish", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const running = deferred<{ content: [] }>();
    vi.spyOn(session.client, "listTools").mockReturnValue(pending.promise);
    vi.spyOn(session.client, "callTool").mockReturnValue(running.promise);
    try {
      const listing = session.listTools();
      const rejected = expect(listing).rejects.toThrow("not connected");
      const calling = session.callTool("first");
      session.retire();
      pending.resolve({ tools: [tool("obsolete")] });
      await rejected;
      running.resolve({ content: [] });
      expect(await calling).toEqual({ content: [] });
    } finally {
      await session.close();
    }
  });

  it("isolates catalogs between connections", async () => {
    const first = await connected();
    const second = await connected();
    vi.spyOn(first.client, "listTools").mockResolvedValue({ tools: [tool("private")] });
    const list = vi.spyOn(second.client, "listTools").mockResolvedValue({ tools: [] });
    try {
      await first.listTools();
      expect((await second.listTools()).tools).toEqual([]);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});
