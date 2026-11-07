// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { validateToolArguments } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { executeGraphqlOperation, importGraphqlSchema } from "./graphql-connectors.js";
import { parametersFor } from "./pi-runtime-tool-parameters.js";

type Ref = { kind: string; name?: string; ofType?: Ref };
const string: Ref = { kind: "SCALAR", name: "String" };
const nonNull = (ofType: Ref): Ref => ({ kind: "NON_NULL", ofType });
const list = (ofType: Ref): Ref => ({ kind: "LIST", ofType });
const input = (name: string): Ref => ({ kind: "INPUT_OBJECT", name });

function operation(type: unknown, defaults?: string | null, types: Record<string, unknown>[] = []) {
  return importGraphqlSchema({
    data: {
      __schema: {
        queryType: { name: "Query" },
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "echo",
                args: [{ name: "value", type, defaultValue: defaults }],
                type: string,
              },
            ],
          },
          { kind: "SCALAR", name: "String" },
          ...types,
        ],
      },
    },
  })[0]!;
}

function parameters(op: ReturnType<typeof operation>) {
  return parametersFor({ name: op.id, description: "", inputSchema: op.inputSchema });
}

describe("GraphQL input nullability", () => {
  it.each([{}, { value: null }])(
    "preserves direct legacy stored-operation variables without guessing nullability: %j",
    async (args) => {
      const op = {
        ...operation(string),
        inputSemanticsVersion: undefined,
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      };
      let payload: Record<string, unknown> | undefined;
      await executeGraphqlOperation(
        "https://graphql.example.test/query",
        { auth: { type: "none" }, headers: {}, operations: [op] },
        op,
        args,
        undefined,
        new AbortController().signal,
        {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
          fetch: async (_url, init) => {
            payload = JSON.parse(String(init?.body));
            return Response.json({ data: { echo: null } });
          },
        },
      );
      expect(payload?.variables).toEqual(args);
    },
  );

  it("rejects invalid null before HTTP when execution bypasses the runtime", async () => {
    const op = operation(nonNull(string), '"fallback"');
    const fetch = vi.fn();
    await expect(
      executeGraphqlOperation(
        "https://api.example.test/graphql",
        { auth: { type: "none" }, headers: {}, operations: [op] },
        op,
        { value: null },
        undefined,
        new AbortController().signal,
        { fetch },
      ),
    ).rejects.toThrow("GraphQL arguments contain an invalid null value.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "T", type: string, omitted: true, valid: ["text", null], invalid: [42, []] },
    { name: "T!", type: nonNull(string), omitted: false, valid: ["text"], invalid: [null, 42, []] },
    {
      name: "[T]",
      type: list(string),
      omitted: true,
      valid: [[], ["text", null], null],
      invalid: ["text", [42]],
    },
    {
      name: "[T!]",
      type: list(nonNull(string)),
      omitted: true,
      valid: [[], ["text"], null],
      invalid: [[null], "text"],
    },
    {
      name: "[T]!",
      type: nonNull(list(string)),
      omitted: false,
      valid: [[], ["text", null]],
      invalid: [null, "text"],
    },
    {
      name: "[T!]!",
      type: nonNull(list(nonNull(string))),
      omitted: false,
      valid: [[], ["text"]],
      invalid: [null, [null], "text"],
    },
  ])(
    "distinguishes omitted values, list nullability and item nullability for $name",
    ({ type, omitted, valid, invalid }) => {
      const schema = parameters(operation(type));
      expect(Check(schema, {})).toBe(omitted);
      for (const value of valid) expect(Check(schema, { value })).toBe(true);
      for (const value of invalid) expect(Check(schema, { value })).toBe(false);
    },
  );

  it("permits omission of a defaulted NON_NULL argument while rejecting an explicit null", () => {
    const op = operation(nonNull(string), '"null"');
    expect(op.variableTypes.value).toBe("String");
    expect(Check(parameters(op), {})).toBe(true);
    expect(Check(parameters(op), { value: null })).toBe(false);
    expect(Check(parameters(op), { value: "text" })).toBe(true);
  });

  it("preserves nullable enum constraints and explicit null through SDK validation", () => {
    const op = operation({ kind: "ENUM", name: "Choice" }, undefined, [
      { kind: "ENUM", name: "Choice", enumValues: [{ name: "ONE" }, { name: "TWO" }] },
    ]);
    const schema = parameters(op);
    expect(Check(schema, { value: null })).toBe(true);
    expect(Check(schema, { value: "ONE" })).toBe(true);
    expect(Check(schema, { value: "OTHER" })).toBe(false);
    const validated = validateToolArguments(
      { name: op.id, description: "", parameters: schema },
      { type: "toolCall", id: "fixture-call", name: op.id, arguments: { value: null } },
    );
    expect(validated).toEqual({ value: null });
  });

  it("keeps input-field required/default/null semantics independent", () => {
    const op = operation(nonNull(input("Settings")), undefined, [
      {
        kind: "INPUT_OBJECT",
        name: "Settings",
        inputFields: [
          { name: "requiredValue", type: nonNull(string), defaultValue: null },
          { name: "defaultedValue", type: nonNull(string), defaultValue: '"fallback"' },
          { name: "optionalValue", type: string, defaultValue: null },
          { name: "items", type: list(string), defaultValue: null },
        ],
      },
    ]);
    const schema = parameters(op);
    expect(Check(schema, { value: { requiredValue: "text" } })).toBe(true);
    expect(
      Check(schema, { value: { requiredValue: "text", optionalValue: null, items: [null] } }),
    ).toBe(true);
    expect(Check(schema, { value: { requiredValue: null } })).toBe(false);
    expect(Check(schema, { value: { requiredValue: "text", defaultedValue: null } })).toBe(false);
    expect(Check(schema, { value: {} })).toBe(false);
    expect(Check(schema, { value: null })).toBe(false);
  });

  it.each([
    undefined,
    {},
    { kind: "NON_NULL" },
    nonNull(nonNull(string)),
    { kind: "LIST" },
    { kind: "SCALAR" },
    input("Missing"),
    { kind: "ENUM", name: "Missing" },
    { kind: "OBJECT", name: "Query" },
  ])(
    "rejects malformed or unresolved input references instead of unconstrained schemas: %j",
    (type) => {
      expect(() => operation(type)).toThrow("GraphQL schema has an invalid input definition.");
    },
  );

  it.each(["null", " null "])(
    "rejects a NON_NULL argument with invalid null default %j",
    (defaults) => {
      expect(() => operation(nonNull(string), defaults)).toThrow(
        "GraphQL schema has an invalid input definition.",
      );
    },
  );

  it("rejects invalid nested input defaults and wrapper chains", () => {
    expect(() =>
      operation(input("Settings"), undefined, [
        {
          kind: "INPUT_OBJECT",
          name: "Settings",
          inputFields: [{ name: "value", type: nonNull(string), defaultValue: "null" }],
        },
      ]),
    ).toThrow("GraphQL schema has an invalid input definition.");
    let type = string;
    for (let i = 0; i < 12; i++) type = list(type);
    expect(() => operation(type)).toThrow("GraphQL schema has an invalid input definition.");
  });

  it("keeps nullable recursive input objects bounded", () => {
    const op = operation(input("Node"), undefined, [
      {
        kind: "INPUT_OBJECT",
        name: "Node",
        inputFields: [
          { name: "label", type: string },
          { name: "next", type: input("Node") },
        ],
      },
    ]);
    expect(Check(parameters(op), { value: { label: null, next: null } })).toBe(true);
    expect(JSON.stringify(op.inputSchema).length).toBeLessThan(2000);
  });

  it.each([{}, { value: null }, { value: { optionalValue: null } }])(
    "sends the exact supplied variables without applying server defaults: %j",
    async (args) => {
      const op = operation(input("Settings"), undefined, [
        {
          kind: "INPUT_OBJECT",
          name: "Settings",
          inputFields: [{ name: "optionalValue", type: string, defaultValue: '"server-default"' }],
        },
      ]);
      let payload: Record<string, unknown> | undefined;
      await executeGraphqlOperation(
        "https://graphql.example.test/query",
        { auth: { type: "none" }, headers: {}, operations: [op] },
        op,
        args,
        undefined,
        new AbortController().signal,
        {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
          fetch: async (_url, init) => {
            payload = JSON.parse(String(init?.body));
            return Response.json({ data: { echo: null } });
          },
        },
      );
      expect(payload?.variables).toEqual(args);
    },
  );
});
