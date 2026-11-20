// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getLogger } from "@orkbot/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpClient } from "./mcp-output-schema.js";

const serverName = "legacy-regex-server";

function setup(tools: Tool[]) {
  const client = createMcpClient(
    { name: "output-schema-test", version: "1" },
    undefined,
    serverName,
  );
  const request = vi.spyOn(client, "request").mockResolvedValueOnce({ tools });
  return { client, request };
}

function tool(name: string, properties: Record<string, object>): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    outputSchema: { type: "object", properties, required: Object.keys(properties) },
  };
}

function result(structuredContent: Record<string, unknown>) {
  return { content: [], structuredContent };
}

afterEach(() => vi.restoreAllMocks());

describe("createMcpClient output schema validation", () => {
  it("keeps valid patterns and validates structuredContent through the SDK", async () => {
    const healthy = tool("healthy", { code: { type: "string", pattern: "^[A-Z]{2}$" } });
    const { client, request } = setup([healthy]);
    expect((await client.listTools()).tools).toEqual([healthy]);
    request.mockResolvedValueOnce(result({ code: "AB" }));
    await expect(client.callTool({ name: "healthy" })).resolves.toEqual(result({ code: "AB" }));
    request.mockResolvedValueOnce(result({ code: "invalid" }));
    await expect(client.callTool({ name: "healthy" })).rejects.toThrow(/output schema/i);
  });

  it.each(["^a\\-b$", "^a\\_b$"])(
    "accepts legacy identity escapes in %s without weakening validation",
    async (pattern) => {
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
      const original = tool("legacy", { code: { type: "string", pattern } });
      const before = structuredClone(original);
      const { client, request } = setup([original]);
      await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: "legacy" }] });
      expect(warn).toHaveBeenCalledWith("mcp.output_schema_adjusted", {
        "mcp.server": serverName,
        "mcp.tool": "legacy",
        reason: "pattern_repaired",
      });
      expect(original).toEqual(before);
      const code = pattern.includes("_") ? "a_b" : "a-b";
      request.mockResolvedValueOnce(result({ code }));
      await expect(client.callTool({ name: "legacy" })).resolves.toEqual(result({ code }));
      request.mockResolvedValueOnce(result({ code: "wrong" }));
      await expect(client.callTool({ name: "legacy" })).rejects.toThrow(/output schema/i);
    },
  );

  it("omits only a broken regex and retains sibling constraints", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const broken = tool("broken-pattern", {
      code: { type: "string", pattern: "[", minLength: 3 },
      count: { type: "integer", minimum: 1 },
      nested: { type: "object", properties: { value: { type: "string", pattern: "^ok$" } } },
    });
    const before = structuredClone(broken);
    const healthy = tool("healthy", { value: { type: "integer" } });
    const { client, request } = setup([broken, healthy]);
    expect((await client.listTools()).tools).toEqual([broken, healthy]);
    expect(broken).toEqual(before);
    request.mockResolvedValueOnce(result({ code: "abc", count: 1, nested: { value: "ok" } }));
    await expect(client.callTool({ name: "broken-pattern" })).resolves.toBeDefined();
    for (const invalid of [
      { code: "a", count: 1, nested: { value: "ok" } },
      { code: "abc", count: 0, nested: { value: "ok" } },
      { code: "abc", count: 1, nested: { value: "bad" } },
    ]) {
      request.mockResolvedValueOnce(result(invalid));
      await expect(client.callTool({ name: "broken-pattern" })).rejects.toThrow(/output schema/i);
    }
    request.mockResolvedValueOnce(result({ value: "bad" }));
    await expect(client.callTool({ name: "healthy" })).rejects.toThrow(/output schema/i);
  });

  it("isolates non-regex compilation failures to their tool", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const uncompileable = tool("unsupported-schema", { value: { $ref: "#/missing-schema" } });
    const healthy = tool("healthy", { value: { type: "integer", minimum: 1 } });
    const { client, request } = setup([uncompileable, healthy]);
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual([
      "unsupported-schema",
      "healthy",
    ]);
    request.mockResolvedValueOnce(result({ arbitrary: "still usable" }));
    await expect(client.callTool({ name: "unsupported-schema" })).resolves.toEqual(
      result({ arbitrary: "still usable" }),
    );
    request.mockResolvedValueOnce(result({ value: 0 }));
    await expect(client.callTool({ name: "healthy" })).rejects.toThrow(/output schema/i);
    request.mockResolvedValueOnce(result({ value: 1 }));
    await expect(client.callTool({ name: "healthy" })).resolves.toEqual(result({ value: 1 }));
  });

  it("preserves literal pattern keys when another property needs repair", async () => {
    vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const literal = { pattern: "[", nested: { pattern: "\\_" } };
    const schema = tool("literal-values", {
      fixed: { const: literal },
      choice: { enum: [literal], default: literal, examples: [literal] },
      code: { type: "string", pattern: "^a\\-b$" },
    });
    const before = structuredClone(schema);
    const { client, request } = setup([schema]);
    await client.listTools();
    expect(schema).toEqual(before);
    request.mockResolvedValueOnce(result({ fixed: literal, choice: literal, code: "a-b" }));
    await expect(client.callTool({ name: "literal-values" })).resolves.toBeDefined();
    request.mockResolvedValueOnce(
      result({ fixed: { pattern: "different" }, choice: literal, code: "a-b" }),
    );
    await expect(client.callTool({ name: "literal-values" })).rejects.toThrow(/output schema/i);
  });

  it("identifies the server and failing tool in warnings without logging the source schema", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const secret = "private-schema-description-9bd798";
    const broken = tool("private-tool", {
      code: { type: "string", pattern: "[", description: secret },
    });
    const { client } = setup([broken]);
    await client.listTools();
    const messages = JSON.stringify(warn.mock.calls);
    expect(warn).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "mcp.output_schema_adjusted",
      expect.objectContaining({
        "mcp.server": serverName,
        "mcp.tool": "private-tool",
        reason: "pattern_omitted",
      }),
    );
    expect(messages).toContain(serverName);
    expect(messages).toContain("private-tool");
    expect(messages).not.toContain(secret);
    expect(messages).not.toContain('"properties"');
  });
});
