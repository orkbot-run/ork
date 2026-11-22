// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AdapterContext } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";
import { ConnectorRegistry } from "./composio-connector.js";
import { ManagedIntegrationConnector } from "./managed-integration-connector.js";

const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context: AdapterContext = {
  operationId: "op",
  traceId: "trace",
  spaceId: "local-space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

function fixture() {
  const binding = vi.fn(async () => ({
    id: workspaceId,
    state: "ready",
    validUntil: new Date(Date.now() + 60_000),
  }));
  const membership = vi.fn(async () => ({ active: true }));
  const bot = vi.fn(async () => ({ id: "bot", name: "Assistant" }));
  const prisma = {
    centralWorkspaceBinding: { findUnique: binding },
    centralWorkspaceAccess: { findUnique: membership },
    bot: { findFirst: bot },
  } as unknown as PrismaClient;
  const registered = vi.fn(async () => true);
  const request = vi.fn(async (path: string) =>
    path.endsWith("catalog")
      ? [
          {
            connectionId,
            tools: [
              {
                name: "read",
                description: "Read information",
                inputSchema: { type: "object", properties: {} },
                readOnly: true,
              },
            ],
          },
        ]
      : { content: [{ type: "text", text: "example" }] },
  );
  const connector = new ManagedIntegrationConnector(prisma, {
    registered,
    managedIntegrationRequest: request,
  });
  return { connector, binding, membership, bot, registered, request };
}

it("discovers assigned tools and invokes the same connection through the connector registry", async () => {
  const f = fixture();
  const registry = new ConnectorRegistry([f.connector]);
  const tools = await registry.discoverTools(context);
  expect(tools).toHaveLength(1);
  expect(tools[0]!.readOnly).toBe(true);
  expect(tools[0]!.route).toEqual({
    connectorId: "managed-integration",
    resourceId: connectionId,
    toolName: "read",
  });
  const events = [];
  for await (const event of registry.execute(
    { tool: tools[0]!.name, args: { query: "test" }, route: tools[0]!.route, executionId: "exec" },
    context,
  ))
    events.push(event);
  expect(events).toEqual([
    { type: "result", data: { content: [{ type: "text", text: "example" }] } },
  ]);
  expect(f.request).toHaveBeenLastCalledWith(
    "/api/integrations/invoke",
    { workspaceId, botId: "bot", connectionId, tool: "read", arguments: { query: "test" } },
    context.signal,
  );
});

it("never discovers or invokes tools after local membership or bot access is gone", async () => {
  const f = fixture();
  f.membership.mockResolvedValueOnce({ active: false });
  expect(await f.connector.discoverTools(context)).toEqual([]);
  expect(f.request).not.toHaveBeenCalled();
  f.bot.mockResolvedValueOnce(null as never);
  expect(await f.connector.discoverTools(context)).toEqual([]);
  expect(f.request).not.toHaveBeenCalled();
});

it("rejects a fabricated route and does not forward it to the managed service", async () => {
  const f = fixture();
  const events = [];
  for await (const event of f.connector.execute(
    {
      tool: "read",
      args: {},
      executionId: "exec",
      route: { connectorId: "managed-integration", resourceId: connectionId, toolName: "other" },
    },
    context,
  ))
    events.push(event);
  expect(events[0]).toMatchObject({ type: "error" });
  expect(f.request).not.toHaveBeenCalled();
});
