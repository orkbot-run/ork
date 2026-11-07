// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { mcpDiscoveryLimits, mcpDiscoveryLimitsFromEnv } from "./mcp-discovery.js";
import { listMcpTools } from "./remote-mcp.js";

const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });
const pageBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
function client(pages: Array<{ tools: Tool[]; nextCursor?: string }>) {
  const listTools = vi
    .fn()
    .mockImplementation(
      async () => pages[Math.min(listTools.mock.calls.length - 1, pages.length - 1)]!,
    );
  return { listTools };
}

describe("MCP discovery configuration", () => {
  it("uses bounded backward-compatible page/tool defaults and a catalog-byte budget", () => {
    expect(mcpDiscoveryLimitsFromEnv({})).toEqual({
      maxTools: 250,
      maxPages: 20,
      maxBytes: 16 * 1024 * 1024,
    });
    expect(mcpDiscoveryLimits()).toEqual(mcpDiscoveryLimitsFromEnv({}));
    expect(
      mcpDiscoveryLimitsFromEnv({
        MCP_DISCOVERY_MAX_TOOLS: " 500 ",
        MCP_DISCOVERY_MAX_PAGES: "30",
        MCP_DISCOVERY_MAX_BYTES: "2097152",
      }),
    ).toEqual({ maxTools: 500, maxPages: 30, maxBytes: 2097152 });
  });
  it.each(["0", "-1", "1.5", "NaN", "Infinity", "invalid"])(
    "rejects invalid explicit limits %s",
    (value) => {
      for (const name of [
        "MCP_DISCOVERY_MAX_TOOLS",
        "MCP_DISCOVERY_MAX_PAGES",
        "MCP_DISCOVERY_MAX_BYTES",
      ]) {
        expect(() => mcpDiscoveryLimitsFromEnv({ [name]: value })).toThrow();
      }
    },
  );
  it("rejects unsafe ceilings and unknown programmatic settings", () => {
    for (const value of [
      { maxTools: 10_001 },
      { maxPages: 101 },
      { maxBytes: 64 * 1024 * 1024 + 1 },
      { unknown: 1 },
    ]) {
      expect(() => mcpDiscoveryLimits(value)).toThrow();
    }
  });
});

describe("bounded MCP catalog pagination", () => {
  it("allows an explicitly configured catalog larger than the previous tool cap", async () => {
    const tools = Array.from({ length: 300 }, (_, index) => tool(`tool_${index}`));
    expect(await listMcpTools(client([{ tools }]) as never, {}, { maxTools: 400 })).toEqual({
      tools,
    });
  });
  it("does not retain or send an oversized opaque cursor beyond the catalog budget", async () => {
    const nextCursor = "private-cursor".repeat(1000);
    const peer = client([{ tools: [], nextCursor }]);
    const result = await listMcpTools(peer as never, {}, { maxBytes: 1000 });
    expect(result.diagnostic).toMatchObject({ reason: "byte_limit", pagesRead: 1, toolsListed: 0 });
    expect(peer.listTools).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private-cursor");
  });
  it("detects a cursor cycle longer than one repeated page", async () => {
    const peer = client([
      { tools: [], nextCursor: "one" },
      { tools: [], nextCursor: "two" },
      { tools: [], nextCursor: "one" },
    ]);
    const result = await listMcpTools(peer as never, {}, {});
    expect(result.diagnostic).toMatchObject({ reason: "cursor_cycle", pagesRead: 3 });
    expect(peer.listTools).toHaveBeenCalledTimes(3);
  });
  it("returns the complete catalog without a diagnostic at exact limits", async () => {
    const pages = [{ tools: [tool("one")], nextCursor: "next" }, { tools: [tool("two")] }];
    const peer = client(pages);
    const result = await listMcpTools(
      peer as never,
      {},
      { maxTools: 2, maxPages: 2, maxBytes: pages.reduce((sum, page) => sum + pageBytes(page), 0) },
    );
    expect(result).toEqual({ tools: [tool("one"), tool("two")] });
    expect(peer.listTools.mock.calls.map(([params]) => params)).toEqual([
      undefined,
      { cursor: "next" },
    ]);
  });
  it("bounds tools from one oversized catalog page and exposes truncation", async () => {
    const peer = client([{ tools: [tool("one"), tool("two"), tool("three")] }]);
    const result = await listMcpTools(peer as never, {}, { maxTools: 2 });
    expect(result.tools).toEqual([tool("one"), tool("two")]);
    expect(result.diagnostic).toMatchObject({ reason: "tool_limit", toolsListed: 2, pagesRead: 1 });
    expect(peer.listTools).toHaveBeenCalledOnce();
  });
  it("stops after the configured page count even when each page is empty", async () => {
    const peer = client([
      { tools: [], nextCursor: "one" },
      { tools: [], nextCursor: "two" },
    ]);
    const result = await listMcpTools(peer as never, {}, { maxPages: 2 });
    expect(result.tools).toEqual([]);
    expect(result.diagnostic).toMatchObject({ reason: "page_limit", toolsListed: 0, pagesRead: 2 });
    expect(peer.listTools).toHaveBeenCalledTimes(2);
  });
  it.each(["repeated", ""])("bounds an opaque repeated cursor including %j", async (cursor) => {
    const peer = client([{ tools: [tool("one")], nextCursor: cursor }]);
    const result = await listMcpTools(peer as never, {}, {});
    expect(result.tools).toEqual([tool("one"), tool("one")]);
    expect(result.diagnostic).toMatchObject({ reason: "cursor_cycle", pagesRead: 2 });
    expect(peer.listTools.mock.calls.map(([params]) => params)).toEqual([undefined, { cursor }]);
    expect(JSON.stringify(result.diagnostic)).not.toContain(cursor || '"cursor":""');
  });
  it("follows an empty cursor once and stops only when it is absent", async () => {
    const peer = client([{ tools: [], nextCursor: "" }, { tools: [tool("last")] }]);
    const result = await listMcpTools(peer as never, {}, {});
    expect(result).toEqual({ tools: [tool("last")] });
    expect(peer.listTools.mock.calls[1]?.[0]).toEqual({ cursor: "" });
  });
  it("bounds aggregate catalog bytes across individually small pages", async () => {
    const pages = [{ tools: [tool("one")], nextCursor: "next" }, { tools: [tool("two")] }];
    const peer = client(pages);
    const result = await listMcpTools(peer as never, {}, { maxBytes: pageBytes(pages[0]) + 1 });
    expect(result.tools).toEqual([tool("one")]);
    expect(result.diagnostic).toEqual({
      reason: "byte_limit",
      toolsListed: 1,
      pagesRead: 2,
      catalogBytes: pages.reduce((sum, page) => sum + pageBytes(page), 0),
    });
    expect(peer.listTools).toHaveBeenCalledTimes(2);
  });
  it("counts UTF-8 bytes and metadata instead of JavaScript characters or tool count alone", async () => {
    const page = { tools: [{ ...tool("one"), description: "ą".repeat(100) }] };
    const result = await listMcpTools(
      client([page]) as never,
      {},
      { maxBytes: JSON.stringify(page).length },
    );
    expect(result.tools).toEqual([]);
    expect(result.diagnostic).toMatchObject({
      reason: "byte_limit",
      catalogBytes: pageBytes(page),
    });
  });
  it("validates programmatic limits before contacting a server", async () => {
    const peer = client([{ tools: [] }]);
    await expect(listMcpTools(peer as never, {}, { maxTools: 0 })).rejects.toThrow();
    expect(peer.listTools).not.toHaveBeenCalled();
  });
});
