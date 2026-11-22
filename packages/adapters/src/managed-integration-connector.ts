// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import { z } from "zod";

const toolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/),
  description: z.string().max(1000),
  inputSchema: z
    .record(z.string(), z.unknown())
    .refine((value) => value.type === "object" && JSON.stringify(value).length <= 16_384),
  readOnly: z.boolean(),
});
const catalogSchema = z
  .array(z.object({ connectionId: z.string().uuid(), tools: z.array(toolSchema).max(100) }))
  .max(100);
const id = "managed-integration";

type ManagedClient = {
  registered(): Promise<boolean>;
  managedIntegrationRequest(
    path: "/api/integrations/catalog" | "/api/integrations/invoke",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

/** The operator's installation proves its identity; provider credentials remain in the managed service. */
export class ManagedIntegrationConnector implements ConnectorProvider {
  private unavailableUntil = 0;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly client: ManagedClient,
  ) {}

  describe() {
    return {
      id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  private async target(context: AdapterContext) {
    if (!context.botId || !(await this.client.registered())) return null;
    return runAsSystem("verify managed integration workspace, member and bot", async () => {
      const binding = await this.prisma.centralWorkspaceBinding.findUnique({
        where: { spaceId: context.spaceId },
      });
      if (binding?.state !== "ready" || binding.validUntil.getTime() <= Date.now()) return null;
      const [membership, bot] = await Promise.all([
        this.prisma.centralWorkspaceAccess.findUnique({
          where: { workspaceId_userId: { workspaceId: binding.id, userId: context.userId } },
        }),
        this.prisma.bot.findFirst({
          where: {
            id: context.botId,
            spaceId: context.spaceId,
            userId: context.userId,
            archivedAt: null,
          },
        }),
      ]);
      return membership?.active && bot
        ? {
            workspaceId: binding.id,
            botId: bot.id,
            botName:
              Array.from(bot.name)
                .map((character) =>
                  character.codePointAt(0)! < 32 || character.codePointAt(0) === 127
                    ? " "
                    : character,
                )
                .join("")
                .trim()
                .slice(0, 200) || "Bot",
          }
        : null;
    });
  }

  private async catalog(context: AdapterContext) {
    const target = await this.target(context);
    if (!target) return { target: null, connections: [] };
    if (this.unavailableUntil > Date.now()) return { target, connections: [] };
    try {
      const result = await this.client.managedIntegrationRequest(
        "/api/integrations/catalog",
        target,
        context.signal,
      );
      return { target, connections: catalogSchema.parse(result) };
    } catch (error) {
      // The service is optional; older Accounts versions do not expose it.
      if (error && typeof error === "object" && "status" in error && error.status === 404) {
        this.unavailableUntil = Date.now() + 30_000;
        return { target, connections: [] };
      }
      throw error;
    }
  }

  private toolName(connectionId: string, name: string) {
    return `managed_${createHash("sha256")
      .update(JSON.stringify([connectionId, name]))
      .digest("hex")
      .slice(0, 24)}`;
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const { connections } = await this.catalog(context);
    return connections.flatMap((connection) =>
      connection.tools.map((tool) => ({
        name: this.toolName(connection.connectionId, tool.name),
        description: `${tool.description} (connection ${connection.connectionId.slice(0, 8)})`,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly,
        route: { connectorId: id, resourceId: connection.connectionId, toolName: tool.name },
      })),
    );
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    try {
      const route = call.route;
      if (!route || route.connectorId !== id || !route.resourceId || call.tool !== route.toolName)
        throw new Error("Invalid integration route");
      const { target, connections } = await this.catalog(context);
      const connection = connections.find(
        (candidate) => candidate.connectionId === route.resourceId,
      );
      if (!target || !connection?.tools.some((tool) => tool.name === route.toolName))
        throw new Error("Integration access unavailable");
      const result = await this.client.managedIntegrationRequest(
        "/api/integrations/invoke",
        {
          workspaceId: target.workspaceId,
          botId: target.botId,
          connectionId: connection.connectionId,
          tool: route.toolName,
          arguments: call.args,
        },
        context.signal,
      );
      yield { type: "result", data: result };
    } catch {
      yield { type: "error", message: "Integration request could not be completed." };
    }
  }
}
