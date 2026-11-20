// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpFormResponse } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { installMcpFormHandler, MCP_TOOL_MAX_TOTAL_MS } from "./mcp-tool-call.js";
import { McpSession } from "./mcp-transport.js";
import { mcpFormRequest } from "./mcp-transport-form.js";
import { callRemoteMcpConnectorTool, RemoteMcpSessionCache } from "./remote-mcp.js";

const params = {
  message: "Choose a label",
  requestedSchema: {
    type: "object",
    properties: { label: { type: "string", minLength: 1 } },
    required: ["label"],
  },
};

afterEach(() => vi.useRealTimers());

it("converts flat fields and rejects unsupported, sensitive, secret-bearing and oversized forms", () => {
  expect(mcpFormRequest("Calendar", params)?.fields).toEqual([
    { name: "label", type: "string", required: true, minLength: 1 },
  ]);
  expect(
    mcpFormRequest("Calendar", {
      ...params,
      requestedSchema: {
        ...params.requestedSchema,
        properties: { label: { type: "string", pattern: "x" } },
      },
    }),
  ).toBeUndefined();
  expect(
    mcpFormRequest("Calendar", { ...params, message: "token-123" }, ["token-123"]),
  ).toBeUndefined();
  for (const field of [
    { type: "object" },
    { type: "array" },
    { type: "string", maxLength: 99999 },
  ]) {
    expect(
      mcpFormRequest("Calendar", {
        ...params,
        requestedSchema: { ...params.requestedSchema, properties: { label: field } },
      }),
    ).toBeUndefined();
  }
  expect(
    mcpFormRequest("Calendar", {
      ...params,
      requestedSchema: { type: "object", properties: { password: { type: "string" } } },
    }),
  ).toBeUndefined();
});

async function fixture(connect = true) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  const server = new Server({ name: "forms", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await extra.sendRequest(
      { method: "elicitation/create", params: { ...params, message: request.params.name } },
      ElicitResultSchema,
      { timeout: 2_147_483_647 },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  await server.connect(transport);
  const http = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No loopback address");
  const session = new McpSession();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  if (connect)
    await session.connectRemote({
      url: `http://127.0.0.1:${address.port}/mcp`,
      urlPolicy: { allowHttpLocalhost: true, allowPrivateEndpoint: true },
    });
  return {
    endpoint,
    server,
    session,
    close: async () => {
      vi.useRealTimers();
      await session.close();
      await server.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

it("routes concurrent real SDK HTTP elicitation to its exact call and immediately declines no-human calls", async () => {
  const f = await fixture();
  try {
    expect(f.server.getClientCapabilities()?.elicitation).toEqual({ form: {} });
    const elicitA = vi.fn(async (request) => ({
      action: "accept" as const,
      content: { label: request.message },
    }));
    const elicitB = vi.fn(async (request) => ({
      action: "accept" as const,
      content: { label: request.message },
    }));
    const results = await Promise.all([
      f.session.callTool("first", {}, { form: { integrationName: "Forms", elicit: elicitA } }),
      f.session.callTool("second", {}, { form: { integrationName: "Forms", elicit: elicitB } }),
      f.session.callTool("background", {}),
    ]);
    expect(elicitA).toHaveBeenCalledOnce();
    expect(elicitB).toHaveBeenCalledOnce();
    expect(elicitA.mock.calls[0]![0].message).toBe("first");
    expect(elicitB.mock.calls[0]![0].message).toBe("second");
    expect(results.map((result) => result.content[0])).toEqual([
      { type: "text", text: JSON.stringify({ action: "accept", content: { label: "first" } }) },
      { type: "text", text: JSON.stringify({ action: "accept", content: { label: "second" } }) },
      { type: "text", text: JSON.stringify({ action: "decline" }) },
    ]);
  } finally {
    await f.close();
  }
});

it("excludes human wait from both tool clocks with the real SDK HTTP stream", async () => {
  const f = await fixture();
  try {
    let answer!: (response: McpFormResponse) => void;
    let shown!: () => void;
    const ready = new Promise<void>((resolve) => {
      shown = resolve;
    });
    const result = f.session.callTool(
      "waiting",
      {},
      {
        form: {
          integrationName: "Forms",
          elicit: async () => {
            shown();
            return new Promise<McpFormResponse>((resolve) => {
              answer = resolve;
            });
          },
        },
      },
    );
    await ready;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(MCP_TOOL_MAX_TOTAL_MS + 60_000);
    vi.useRealTimers();
    answer({ action: "accept", content: { label: "after waiting" } });
    expect((await result).content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action: "accept", content: { label: "after waiting" } }),
    });
  } finally {
    await f.close();
  }
});

it("aborts the human callback when its exact tool call is cancelled", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    let shown!: () => void;
    let callbackSignal!: AbortSignal;
    const ready = new Promise<void>((resolve) => {
      shown = resolve;
    });
    const result = f.session
      .callTool(
        "cancel",
        {},
        {
          signal: controller.signal,
          form: {
            integrationName: "Forms",
            elicit: async (_request, signal) => {
              callbackSignal = signal;
              shown();
              return new Promise<McpFormResponse>(() => {});
            },
          },
        },
      )
      .catch((error: unknown) => error);
    await ready;
    controller.abort(new Error("Run cancelled"));
    expect(await result).toBeInstanceOf(Error);
    expect(callbackSignal.aborted).toBe(true);
  } finally {
    await f.close();
  }
});

it("isolates concurrent real SDK stdio invocations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-form-test-"));
  const path = join(dir, "server.mjs");
  await writeFile(
    path,
    `
    import {Server} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import {CallToolRequestSchema,ElicitResultSchema} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
    const server=new Server({name:'forms',version:'1'},{capabilities:{tools:{}}});
    server.setRequestHandler(CallToolRequestSchema, async (request,extra)=>{
      const result=await extra.sendRequest({method:'elicitation/create',params:{...${JSON.stringify(params)},message:request.params.name}},ElicitResultSchema);
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    });
    await server.connect(new StdioServerTransport());
  `,
  );
  const sessions = [
    new McpSession({ isolatedElicitation: true }),
    new McpSession({ isolatedElicitation: true }),
  ];
  try {
    await Promise.all(
      sessions.map((session) =>
        session.connectStdio({
          command: process.execPath,
          args: [path],
          allowedCommands: [process.execPath],
        }),
      ),
    );
    const results = await Promise.all(
      sessions.map((session, index) =>
        session.callTool(
          `call-${index}`,
          {},
          {
            form: {
              integrationName: "Forms",
              elicit: async (request) => ({
                action: "accept",
                content: { label: request.message },
              }),
            },
          },
        ),
      ),
    );
    expect(results.map((result) => result.content[0])).toEqual(
      [0, 1].map((index) => ({
        type: "text",
        text: JSON.stringify({ action: "accept", content: { label: `call-${index}` } }),
      })),
    );
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

it("routes catalog/custom forms through one shared remote session without retaining callback state", async () => {
  const f = await fixture(false);
  const pool = new RemoteMcpSessionCache(0);
  try {
    const options = {
      endpoint: f.endpoint,
      allowPrivateEndpoint: true,
      sessionPool: pool,
      sessionScope: "same-run",
    };
    const results = await Promise.all(
      ["one", "two"].map((name) =>
        callRemoteMcpConnectorTool(
          {
            ...options,
            form: {
              integrationName: "Catalog",
              elicit: async (request) => ({
                action: "accept",
                content: { label: request.message },
              }),
            },
          },
          name,
          {},
          [],
        ),
      ),
    );
    expect(results).toEqual(
      ["one", "two"].map((name) =>
        expect.objectContaining({
          content: [
            { type: "text", text: JSON.stringify({ action: "accept", content: { label: name } }) },
          ],
        }),
      ),
    );
    expect(await callRemoteMcpConnectorTool(options, "background", {}, [])).toEqual(
      expect.objectContaining({
        content: [{ type: "text", text: JSON.stringify({ action: "decline" }) }],
      }),
    );
  } finally {
    await pool.close();
    await f.close();
  }
});

it("declines credential-bearing prompts, invalid human answers and callback errors", async () => {
  const f = await fixture();
  try {
    const callback = vi.fn(async () => ({ action: "accept" as const, content: { label: "safe" } }));
    const secret = await f.session.callTool(
      "configured-secret",
      {},
      {
        form: { integrationName: "Forms", secrets: () => ["configured-secret"], elicit: callback },
      },
    );
    expect(callback).not.toHaveBeenCalled();
    expect(secret.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action: "decline" }),
    });
    const invalid = await f.session.callTool(
      "invalid",
      {},
      {
        form: {
          integrationName: "Forms",
          elicit: async () => ({ action: "accept", content: { label: 42 } }),
        },
      },
    );
    expect(invalid.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action: "decline" }),
    });
    const failed = await f.session.callTool(
      "failure",
      {},
      {
        form: {
          integrationName: "Forms",
          elicit: async () => {
            throw new Error("private answer");
          },
        },
      },
    );
    expect(failed.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ action: "decline" }),
    });
  } finally {
    await f.close();
  }
});

it("cancels a pending human prompt when its transport closes", async () => {
  const f = await fixture();
  try {
    let shown!: () => void;
    let callbackSignal!: AbortSignal;
    const ready = new Promise<void>((resolve) => {
      shown = resolve;
    });
    const result = f.session
      .callTool(
        "close",
        {},
        {
          form: {
            integrationName: "Forms",
            elicit: async (_request, signal) => {
              callbackSignal = signal;
              shown();
              return new Promise<McpFormResponse>(() => {});
            },
          },
        },
      )
      .catch((error: unknown) => error);
    await ready;
    await f.session.close();
    expect(callbackSignal.aborted).toBe(true);
    await result;
  } finally {
    await f.close();
  }
});

it("refuses escaped known secrets and obviously sensitive questions on generic fields", () => {
  for (const secret of ['key"quoted', "key\nnew-line", "key\\slash"]) {
    expect(
      mcpFormRequest("Calendar", { ...params, message: `Use ${secret}` }, [secret]),
    ).toBeUndefined();
    expect(
      mcpFormRequest(
        "Calendar",
        {
          ...params,
          requestedSchema: {
            ...params.requestedSchema,
            properties: { label: { type: "string", default: secret } },
          },
        },
        [secret],
      ),
    ).toBeUndefined();
  }
  expect(
    mcpFormRequest("Calendar", { ...params, message: "Please enter your password" }),
  ).toBeUndefined();
  expect(
    mcpFormRequest("Calendar", { ...params, message: "Enter credit card details" }),
  ).toBeUndefined();
});

it("immediately declines unsolicited server requests outside any tool invocation", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  installMcpFormHandler(client);
  const server = new Server({ name: "test", version: "1" }, { capabilities: { tools: {} } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect(
      await server.request({ method: "elicitation/create", params }, ElicitResultSchema),
    ).toEqual({ action: "decline" });
  } finally {
    await client.close();
    await server.close();
  }
});
