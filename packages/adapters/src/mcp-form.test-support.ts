// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ElicitResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type Endpoint = { server: Server; transport: WebStandardStreamableHTTPServerTransport };
export const MCP_FORM_FIXTURE_HOST = "project-forms.example.test";

/** Standard MCP provider boundary for the renderer journey. No outbound network. */
export function createMcpFormFixture() {
  const sessions = new Map<string, Endpoint>();
  const answers: Array<{ action: string; content?: unknown }> = [];

  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const endpoint = sessions.get(id);
      if (!endpoint) return new Response(null, { status: 404 });
      return endpoint.transport.handleRequest(request);
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let endpoint: Endpoint;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, endpoint);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    const server = new Server(
      { name: "Project form fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    endpoint = { transport, server };
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "get_project",
          description: "Read project details after selecting a project.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (_request, context) => {
      const response = await context.sendRequest(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: "Which project should be opened?",
            requestedSchema: {
              type: "object",
              properties: {
                project: { type: "string", title: "Project name", minLength: 2 },
                include_archived: { type: "boolean", title: "Include archived projects" },
              },
              required: ["project"],
            },
          },
        },
        ElicitResultSchema,
      );
      answers.push(response);
      return {
        content: [{ type: "text", text: `Project tool continued after ${response.action}.` }],
      };
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  return {
    answers,
    fetch,
    close: async () => {
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
    },
  };
}
