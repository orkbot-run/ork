// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AdapterContext } from "@orkbot/adapter-kit";
import { getLogger } from "@orkbot/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstalledConnectorProvider, verifyMcpInstall } from "./installed-connectors.js";
import { McpConnector } from "./mcp-connector.js";
import { mcpDiscoveryMessage } from "./mcp-discovery.js";
import { listRemoteMcpTools } from "./remote-mcp.js";

const endpoint = "https://private-hostname.example.test/mcp";
const context: AdapterContext = {
  spaceId: "space",
  userId: "user",
  botId: "bot",
  operationId: "operation",
  traceId: "trace",
  signal: new AbortController().signal,
};
const server = {
  id: "server",
  slug: "demo",
  name: "Demo",
  transport: "streamable_http",
  endpoint,
  secretId: null,
  args: [],
  revision: 1,
};
function peer() {
  const requests: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json();
    requests.push(message.method);
    if (message.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
    if (message.method === "tools/list")
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "first", description: "private-tool-secret", inputSchema: { type: "object" } },
            { name: "private-tool-name", inputSchema: { type: "object" } },
          ],
          nextCursor: "private-cursor-secret",
        },
      });
    return new Response(null, { status: 202 });
  });
  return {
    requests,
    remote: {
      fetch,
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      discoveryLimits: { maxTools: 1 },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("MCP discovery diagnostic consumers", () => {
  it("preserves partial tools and persists a contextual healthy warning on native discovery/probe", async () => {
    const { remote, requests } = peer();
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const connector = new McpConnector(
      {
        botMcpServer: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { botId: "bot", serverId: "server", allowAllTools: true, allowedTools: [], server },
            ]),
        },
        mcpServer: { findMany: vi.fn().mockResolvedValue([]), updateMany },
      } as never,
      {} as never,
      { network: remote, discoveryLimits: remote.discoveryLimits },
    );
    try {
      const tools = await connector.discoverTools(context);
      expect(tools.map((tool) => tool.route?.toolName)).toEqual(["first"]);
      expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
        healthStatus: "ok",
        healthToolCount: 1,
        healthMessage: mcpDiscoveryMessage({
          reason: "tool_limit",
          toolsListed: 1,
          pagesRead: 1,
          catalogBytes: 1,
        }),
      });
      const probe = await connector.probe(server as never, context);
      expect(probe).toMatchObject({
        status: "ok",
        toolCount: 1,
        message: expect.stringContaining("tool limit"),
      });
      expect(requests.filter((request) => request === "tools/list")).toHaveLength(2);
    } finally {
      await connector.close();
    }
  });
  it("keeps installed discovery and install verification diagnostic/log paths explicit", async () => {
    const { remote } = peer();
    const warn = vi.spyOn(getLogger(), "warn");
    const install = {
      id: "installed",
      name: "Demo",
      kind: "mcp",
      source: endpoint,
      secretId: null,
      config: { preset: "custom", auth: { type: "none" } },
      createdAt: new Date(0),
    };
    const installed = new InstalledConnectorProvider(
      { capabilityInstall: { findMany: vi.fn().mockResolvedValue([install]) } } as never,
      {} as never,
      remote,
    );
    const tools = await installed.discoverTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(["first"]);
    const verified = await verifyMcpInstall({ source: endpoint, config: install.config, remote });
    expect(verified).toMatchObject({
      toolCount: 1,
      diagnostic: { reason: "tool_limit", toolsListed: 1, pagesRead: 1 },
    });
    expect(
      warn.mock.calls.filter(([message]) => message === "mcp.discovery_truncated"),
    ).toHaveLength(2);
    const recorded = JSON.stringify(warn.mock.calls);
    for (const secret of [
      endpoint,
      "private-hostname",
      "private-tool-secret",
      "private-tool-name",
      "private-cursor-secret",
    ])
      expect(recorded).not.toContain(secret);
  });
  it("reports a zero-tool truncated install as incomplete instead of a successful empty source", async () => {
    const { remote } = peer();
    await expect(
      verifyMcpInstall({
        source: endpoint,
        config: { auth: { type: "none" } },
        remote: { ...remote, discoveryLimits: { maxBytes: 1 } },
      }),
    ).rejects.toThrow("catalog size limit");
  });
  it("keeps remote callers' partial result and structural diagnostic together", async () => {
    const { remote } = peer();
    const result = await listRemoteMcpTools({ ...remote, endpoint });
    expect(result.tools.map((tool) => tool.name)).toEqual(["first"]);
    expect(result.diagnostic).toMatchObject({ reason: "tool_limit", toolsListed: 1 });
  });
});
