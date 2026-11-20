// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { McpSession } from "./mcp-transport.js";

const tool = (name: string) => ({ name, inputSchema: { type: "object" as const } });

async function connected(listing?: ListToolsResult) {
  const session = new McpSession();
  await session.connectRemote({
    url: "https://mcp.example.test/mcp",
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = await request.json();
        if (message.method === "tools/list" && listing)
          return Response.json({ jsonrpc: "2.0", id: message.id, result: listing });
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
  it("shares concurrent discovery while keeping each caller's cancellation local", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const list = vi.spyOn(session.client, "listTools").mockReturnValue(pending.promise);
    const controller = new AbortController();
    try {
      const first = session.listTools({ signal: controller.signal });
      const second = session.listTools();
      expect(list).toHaveBeenCalledTimes(1);
      const sharedSignal = list.mock.calls[0]![1]!.signal;
      const rejected = expect(first).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await rejected;
      expect(sharedSignal?.aborted).toBe(false);
      pending.resolve({ tools: [tool("current")] });
      expect((await second).tools).toEqual([tool("current")]);
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }
  });

  it("aborts abandoned discovery only after all waiting callers cancel", async () => {
    const session = await connected();
    const pending = deferred<ListToolsResult>();
    const list = vi
      .spyOn(session.client, "listTools")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ tools: [tool("new")] });
    const firstController = new AbortController();
    const secondController = new AbortController();
    try {
      const first = session.listTools({ signal: firstController.signal });
      const second = session.listTools({ signal: secondController.signal });
      const firstRejected = expect(first).rejects.toThrow("cancelled");
      const secondRejected = expect(second).rejects.toThrow("cancelled");
      const signal = list.mock.calls[0]![1]!.signal;
      firstController.abort(new Error("cancelled"));
      expect(signal?.aborted).toBe(false);
      secondController.abort(new Error("cancelled"));
      expect(signal?.aborted).toBe(true);
      await Promise.all([firstRejected, secondRejected]);
      expect((await session.listTools()).tools).toEqual([tool("new")]);
      pending.resolve({ tools: [tool("abandoned")] });
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await session.close();
    }
  });

  it("bounds retries when every listing is overtaken by a notification", async () => {
    const session = await connected();
    const list = vi.spyOn(session.client, "listTools").mockImplementation(async () => {
      await changed(session);
      return { tools: [tool("obsolete")] };
    });
    try {
      await expect(session.listTools()).rejects.toThrow(
        "changed repeatedly during discovery; retry",
      );
      expect(list).toHaveBeenCalledTimes(2);
      list.mockResolvedValue({ tools: [tool("stable")] });
      expect((await session.listTools()).tools).toEqual([tool("stable")]);
    } finally {
      await session.close();
    }
  });

  it.each(["result", "metadata"])(
    "honors optional %s TTL through SDK validation",
    async (location) => {
      const listing = {
        tools: [tool("first")],
        ...(location === "result" ? { ttlMs: 100 } : { _meta: { ttlMs: 100 } }),
      };
      const session = await connected(listing);
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const list = vi.spyOn(session.client, "listTools");
      try {
        await session.listTools();
        now.mockReturnValue(1_099);
        await session.listTools();
        expect(list).toHaveBeenCalledTimes(1);
        now.mockReturnValue(1_100);
        await session.listTools();
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
        await session.close();
      }
    },
  );

  it("uses the earliest page expiry and includes time spent listing", async () => {
    const session = await connected();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const list = vi
      .spyOn(session.client, "listTools")
      .mockImplementationOnce(async () => {
        now.mockReturnValue(1_050);
        return { tools: [tool("first")], ttlMs: 100, nextCursor: "second" };
      })
      .mockResolvedValueOnce({ tools: [tool("second")], _meta: { ttlMs: 200 } })
      .mockResolvedValue({ tools: [tool("new")] });
    try {
      expect((await session.listTools()).tools).toHaveLength(2);
      now.mockReturnValue(1_099);
      await session.listTools();
      expect(list).toHaveBeenCalledTimes(2);
      now.mockReturnValue(1_100);
      expect((await session.listTools()).tools).toEqual([tool("new")]);
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      now.mockRestore();
      await session.close();
    }
  });

  it.each([0, -1, "100", Number.NaN, Infinity])(
    "handles TTL %s without unbounded timers",
    async (ttlMs) => {
      const session = await connected();
      const list = vi.spyOn(session.client, "listTools").mockResolvedValue({
        tools: [tool("first")],
        ttlMs,
      });
      try {
        await session.listTools();
        await session.listTools();
        expect(list).toHaveBeenCalledTimes(ttlMs === 0 ? 2 : 1);
      } finally {
        await session.close();
      }
    },
  );

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

  it.each(["protocol", "result"])(
    "invalidates unknown-tool %s errors without retrying tool side effects",
    async (kind) => {
      const session = await connected();
      const list = vi
        .spyOn(session.client, "listTools")
        .mockResolvedValue({ tools: [tool("first")] });
      const call = vi.spyOn(session.client, "callTool");
      if (kind === "protocol")
        call.mockRejectedValue(new McpError(ErrorCode.InvalidParams, "Unknown tool"));
      else
        call.mockResolvedValue({
          isError: true,
          content: [{ type: "text", text: "Unknown tool" }],
        });
      try {
        await session.listTools();
        if (kind === "protocol")
          await expect(session.callTool("first")).rejects.toThrow("Unknown tool");
        else expect(await session.callTool("first")).toMatchObject({ isError: true });
        await session.listTools();
        expect(list).toHaveBeenCalledTimes(2);
        expect(call).toHaveBeenCalledTimes(1);
      } finally {
        await session.close();
      }
    },
  );

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
