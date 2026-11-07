// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Model, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";

function validate(parameters: object, args: ToolCall["arguments"]) {
  return validateToolArguments(
    { name: "fixture", description: "Fixture", parameters },
    { type: "toolCall", id: "fixture-call", name: "fixture", arguments: args },
  );
}

describe("Pi tool schema boundary", () => {
  const typed = Type.Object({
    text: Type.String(),
    count: Type.Integer(),
    tags: Type.Array(Type.String()),
  });
  const plain = JSON.parse(JSON.stringify(typed));

  it.each([typed, plain])(
    "coerces plain and TypeBox schemas alike without mutating transcript arguments",
    (schema) => {
      const args = { text: null, count: "3.5", tags: "one" };
      expect(validate(schema, args)).toEqual({ text: "null", count: 3, tags: ["one"] });
      expect(args).toEqual({ text: null, count: "3.5", tags: "one" });
    },
  );

  it.each([typed, plain])("still rejects missing required fields", (schema) => {
    expect(() => validate(schema, { count: 1, tags: [] })).toThrow();
  });

  it("preserves explicit closed objects and string enums", () => {
    const closed = Type.Object(
      { mode: Type.Unsafe<string>({ type: "string", enum: ["a", "b"] }) },
      { additionalProperties: false },
    );
    expect(validate(closed, { mode: "a" })).toEqual({ mode: "a" });
    expect(() => validate(closed, { mode: "c" })).toThrow();
    expect(() => validate(closed, { mode: "a", extra: true })).toThrow();
    expect(validate(Type.Object({ mode: Type.String() }), { mode: "a", extra: true })).toEqual({
      mode: "a",
      extra: true,
    });
  });

  it("rejects a supplied unresolved reference but permits an absent optional one", () => {
    const schema = {
      type: "object",
      properties: { valid: { type: "string" }, missing: { $ref: "#/$defs/missing" } },
      required: ["valid"],
    };
    expect(validate(schema, { valid: "ready" })).toEqual({ valid: "ready" });
    expect(() => validate(schema, { valid: "ready", missing: "value" })).toThrow();
  });

  it("keeps original connector constraints authoritative after wire coercion", () => {
    const schema = {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
    };
    const execute = vi.fn();
    const dispatch = (args: ToolCall["arguments"]) =>
      execute(parseConnectorToolArgs(schema, validate(schema, args)));
    expect(() => dispatch({ id: "0.5" })).toThrow();
    expect(execute).not.toHaveBeenCalled();
    dispatch({ id: "3" });
    expect(execute).toHaveBeenCalledExactlyOnceWith({ id: 3 });
  });
});

it("streams large fragmented tool arguments with stable snapshots and clean transcript blocks", async () => {
  const model: Model<"openai-completions"> = {
    provider: "fixture",
    id: "fixture",
    name: "Fixture",
    api: "openai-completions",
    baseUrl: "https://models.example.test/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const content = "fragment-".repeat(8192);
  const json = JSON.stringify({ path: "notes/result.txt", content });
  const frames = [
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fixture-call",
                type: "function",
                function: { name: "write_file", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    ...Array.from({ length: Math.ceil(json.length / 512) }, (_, index) => ({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: json.slice(index * 512, (index + 1) * 512) } },
            ],
          },
          finish_reason: null,
        },
      ],
    })),
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const fetcher = vi.fn(
    async () =>
      new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const response = stream(
    model,
    normalizeContext({
      messages: [{ role: "user", content: "Write the file.", timestamp: 1 }],
      tools: [
        {
          name: "write_file",
          description: "Write a file",
          parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        },
      ],
    }),
    { apiKey: "fake-fixture-key", fetch: fetcher, maxRetries: 0 },
  );
  const saved: Array<{ args: ToolCall["arguments"]; serialized: string }> = [];
  let partials = 0;
  for await (const event of response) {
    if (event.type !== "toolcall_delta") continue;
    const call = event.partial.content[event.contentIndex];
    if (call?.type !== "toolCall") continue;
    expect(Object.keys(call).sort()).toEqual(["arguments", "id", "name", "type"]);
    if (partials++ % 16 === 0)
      saved.push({ args: call.arguments, serialized: JSON.stringify(call.arguments) });
  }
  const result = await response.result();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toEqual([
    {
      type: "toolCall",
      id: "fixture-call",
      name: "write_file",
      arguments: { path: "notes/result.txt", content },
    },
  ]);
  expect(saved.length).toBeGreaterThan(2);
  expect(
    saved.some(
      ({ args }) =>
        typeof args.content === "string" &&
        args.content.length > 0 &&
        args.content.length < content.length,
    ),
  ).toBe(true);
  for (const snapshot of saved) expect(JSON.stringify(snapshot.args)).toBe(snapshot.serialized);
});
