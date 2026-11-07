// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AgentRunRequest } from "@orkbot/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { executeGraphqlOperation, importGraphqlSchema } from "./graphql-connectors.js";
import { InstalledConnectorProvider } from "./installed-connectors.js";

const provider = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getModel: () => model,
    streamSimple: (...args: unknown[]) => provider.stream(...args),
  }),
}));
vi.mock("./pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("./pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import { PiAgentRuntime } from "./pi-runtime.js";

const model: Model<"anthropic-messages"> = {
  provider: "anthropic",
  id: "graphql-fixture",
  name: "GraphQL fixture",
  api: "anthropic-messages",
  baseUrl: "https://models.example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};
const string = { kind: "SCALAR", name: "String" };
const nonNull = (ofType: unknown) => ({ kind: "NON_NULL", ofType });
const list = (ofType: unknown) => ({ kind: "LIST", ofType });
type Arguments = Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"];

function operation(type: unknown, defaultValue?: string, types: unknown[] = []) {
  return importGraphqlSchema({
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [{ name: "echo", args: [{ name: "value", type, defaultValue }], type: string }],
          },
          { kind: "SCALAR", name: "String" },
          ...types,
        ],
      },
    },
  })[0]!;
}
function stream(content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  };
  const output = new AssistantMessageEventStream();
  output.push({ type: "start", partial: { ...message, content: [] } });
  for (const [contentIndex, part] of content.entries()) {
    if (part.type === "toolCall") {
      output.push({ type: "toolcall_start", contentIndex, partial: message });
      output.push({ type: "toolcall_end", contentIndex, toolCall: part, partial: message });
    }
  }
  output.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
  output.end(message);
  return output;
}

async function run(op: ReturnType<typeof operation>, args: Arguments, viaUseTool: boolean) {
  const config = { auth: { type: "none" as const }, headers: {}, operations: [op] };
  const installed = new InstalledConnectorProvider(
    {
      capabilityInstall: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "graphql-fixture",
            kind: "graphql",
            source: "https://api.example.test/graphql",
            secretId: null,
            createdAt: new Date(0),
            config,
          },
        ]),
      },
    } as never,
    {} as never,
  );
  const context = {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  };
  const tools = await installed.discoverTools(context);
  const network = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { echo: "done" } }), {
        headers: { "content-type": "application/json" },
      }),
  );
  const execute = vi.fn(async (_name: string, actual: Record<string, unknown>) =>
    executeGraphqlOperation(
      "https://api.example.test/graphql",
      config,
      op,
      actual,
      undefined,
      context.signal,
      {
        fetch: network as never,
        resolveHostname: async () => [{ address: "93.184.216.34", family: 4 as const }],
      },
    ),
  );
  const contexts: Context[] = [];
  provider.stream.mockImplementation((_model: unknown, current: Context) => {
    contexts.push(structuredClone(current));
    return stream(
      contexts.length === 1
        ? [
            {
              type: "toolCall",
              id: "fixture-call",
              name: viaUseTool ? "use_tool" : "echo",
              arguments: viaUseTool ? { name: "echo", arguments: args } : args,
            },
          ]
        : [{ type: "text", text: "Done." }],
    );
  });
  const request = {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Read the value",
    instructions: "Use the offered tool.",
    history: [],
    tools: [
      ...tools,
      ...(viaUseTool ? [builtinAgentTools.find((tool) => tool.name === "schedule_cancel")!] : []),
    ],
    model: { provider: model.provider, id: model.id, apiKey: "fake-key" },
    executeTool: execute,
  } as unknown as AgentRunRequest;
  const events = [];
  for await (const event of new PiAgentRuntime().run(request, context)) events.push(event);
  return { network, execute, events, contexts };
}

beforeEach(() => provider.stream.mockReset());

describe("GraphQL arguments in the real SDK agent loop", () => {
  it.each([false, true])(
    "rejects nested NON_NULL nulls before singleton-list coercion (use_tool=%s)",
    async (viaUseTool) => {
      const op = operation(list({ kind: "INPUT_OBJECT", name: "Settings" }), undefined, [
        {
          kind: "INPUT_OBJECT",
          name: "Settings",
          inputFields: [{ name: "defaulted", type: nonNull(string), defaultValue: '"fallback"' }],
        },
      ]);
      const result = await run(op, { value: { defaulted: null } }, viaUseTool);
      expect(result.execute).not.toHaveBeenCalled();
      expect(result.network).not.toHaveBeenCalled();
      expect(result.events.filter((event) => event.type === "tool")).toEqual([]);
    },
  );

  it.each([false, true])(
    "retains valid singleton input-object list coercion (use_tool=%s)",
    async (viaUseTool) => {
      const op = operation(list({ kind: "INPUT_OBJECT", name: "Settings" }), undefined, [
        {
          kind: "INPUT_OBJECT",
          name: "Settings",
          inputFields: [{ name: "defaulted", type: nonNull(string), defaultValue: '"fallback"' }],
        },
      ]);
      const result = await run(op, { value: { defaulted: "text" } }, viaUseTool);
      expect(result.execute.mock.calls[0]?.[1]).toEqual({ value: [{ defaulted: "text" }] });
      expect(result.network).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "keeps legacy stored schema null/omission behavior until reimported (use_tool=%s)",
    async (viaUseTool) => {
      const op = {
        ...operation(string),
        inputSemanticsVersion: undefined,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      };
      const legacyArguments: Arguments[] = [{ value: null }, {}];
      for (const args of legacyArguments) {
        const result = await run(op, args, viaUseTool);
        expect(result.execute).toHaveBeenCalledOnce();
        // Legacy metadata cannot distinguish nullable inputs from defaulted NON_NULL inputs.
        // Keep its previous SDK optional-null omission until the source is imported again.
        expect(result.execute.mock.calls[0]?.[1]).toEqual({});
        expect(result.network).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([false, true])(
    "rejects defaulted NON_NULL explicit null before execution (use_tool=%s)",
    async (viaUseTool) => {
      const result = await run(
        operation(nonNull(string), '"fallback"'),
        { value: null },
        viaUseTool,
      );
      expect(result.execute).not.toHaveBeenCalled();
      expect(result.network).not.toHaveBeenCalled();
      expect(result.events.filter((event) => event.type === "tool")).toEqual([]);
      expect(
        result.contexts
          .flatMap((context) => context.messages)
          .some((message) => message.role === "toolResult" && message.isError),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "rejects nested NON_NULL nulls before execution (use_tool=%s)",
    async (viaUseTool) => {
      const op = operation({ kind: "INPUT_OBJECT", name: "Settings" }, undefined, [
        {
          kind: "INPUT_OBJECT",
          name: "Settings",
          inputFields: [
            { name: "defaulted", type: nonNull(string), defaultValue: '"fallback"' },
            { name: "items", type: list(nonNull(string)) },
          ],
        },
      ]);
      const invalidValues: Arguments[] = [{ defaulted: null }, { items: [null] }];
      for (const value of invalidValues) {
        const result = await run(op, { value }, viaUseTool);
        expect(result.execute).not.toHaveBeenCalled();
        expect(result.network).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "preserves nullable null and both kinds of omission (use_tool=%s)",
    async (viaUseTool) => {
      for (const [op, args] of [
        [operation(string), { value: null }],
        [operation(string), {}],
        [operation(nonNull(string), '"fallback"'), {}],
      ] as const) {
        const result = await run(op, args, viaUseTool);
        expect(result.execute).toHaveBeenCalledOnce();
        expect(result.execute.mock.calls[0]![1]).toEqual(args);
        expect(result.network).toHaveBeenCalledOnce();
        const body = JSON.parse(String(result.network.mock.calls[0]?.[1]?.body));
        expect(body.variables).toEqual(args);
      }
    },
  );

  it("retains SDK numeric ID and scalar-to-singleton-list coercion", async () => {
    const result = await run(operation(list({ kind: "SCALAR", name: "ID" })), { value: 42 }, false);
    expect(result.execute.mock.calls[0]?.slice(0, 2)).toEqual(["echo", { value: ["42"] }]);
    expect(result.network).toHaveBeenCalledOnce();
  });
});
