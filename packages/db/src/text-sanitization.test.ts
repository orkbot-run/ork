// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors (inherited material)
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited UTF-16 tests are preserved; identity-label regressions are Ork additions.

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./generated/prisma/client.js";
import { sanitizeWriteArgs, withTextSanitization } from "./text-sanitization.js";

describe("sanitizeWriteArgs", () => {
  it("replaces NUL and unpaired surrogates in written text and json", () => {
    const at = new Date(0);
    const bytes = new Uint8Array([0]);
    const args = {
      where: { id: "a\0b" },
      data: {
        prompt: "hi\0there 😀",
        createdAt: at,
        ciphertext: bytes,
        payload: { blocks: [{ text: "x\uD800y" }, { text: "fine" }] },
        runs: { create: [{ status: "queued", note: "\uDC00" }] },
      },
    };

    const out = sanitizeWriteArgs("create", args) as typeof args;

    expect(out.data.prompt).toBe("hi�there 😀");
    expect(out.data.payload.blocks[0]?.text).toBe("x�y");
    expect(out.data.payload.blocks[1]).toBe(args.data.payload.blocks[1]);
    expect(out.data.runs.create[0]?.note).toBe("�");
    expect(out.data.createdAt).toBe(at);
    expect(out.data.ciphertext).toBe(bytes);
    // Filters are not rewritten, and the caller's object is not mutated.
    expect(out.where).toBe(args.where);
    expect(args.data.prompt).toBe("hi\0there 😀");
  });

  it("covers both sides of an upsert and returns clean args unchanged", () => {
    const upsert = sanitizeWriteArgs("upsert", {
      where: { id: "1" },
      create: { name: "a\0" },
      update: { name: "b\0" },
    });
    expect(upsert).toEqual({
      where: { id: "1" },
      create: { name: "a�" },
      update: { name: "b�" },
    });

    const clean = { data: [{ name: "ok" }] };
    expect(sanitizeWriteArgs("createMany", clean)).toBe(clean);
  });

  it("cleans JSON keys and keeps keys that collide once cleaned", () => {
    const out = sanitizeWriteArgs("create", {
      data: { payload: { "a\0b": 1, "a�b": 2, nested: { "\uD800": "x" } } },
    });
    expect(out).toEqual({
      data: { payload: { "a�b": 1, "a�b#2": 2, nested: { "�": "x" } } },
    });
  });

  it("keeps a parsed __proto__ key as data when cleaning keys", () => {
    const payload = JSON.parse('{"bad\\u0000":1,"__proto__":{"keep":2}}');
    const out = sanitizeWriteArgs("create", { data: { payload } }) as {
      data: { payload: Record<string, unknown> };
    };

    expect(Object.getPrototypeOf(out.data.payload)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(out.data.payload))).toEqual(
      JSON.parse('{"bad\\ufffd":1,"__proto__":{"keep":2}}'),
    );
    expect(Object.hasOwn(out.data.payload, "__proto__")).toBe(true);
  });

  it("leaves reads alone", () => {
    const args = { where: { name: "a\0" } };
    expect(sanitizeWriteArgs("findFirst", args)).toBe(args);
  });
});

type Hook = (input: {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}) => Promise<unknown>;

const scalar = (name: string, type = "String") => ({ name, kind: "scalar", type });
function sanitizerHook() {
  let hook: Hook | undefined;
  const prisma = {
    _runtimeDataModel: {
      models: {
        Bot: {
          fields: [
            scalar("name"),
            scalar("prompt"),
            scalar("metadata", "Json"),
            { name: "space", kind: "object", type: "Space" },
          ],
        },
        Space: { fields: [scalar("name"), { name: "bots", kind: "object", type: "Bot" }] },
        User: { fields: [scalar("name")] },
        ChatGroup: { fields: [scalar("name")] },
        Page: { fields: [scalar("title"), scalar("content", "Json")] },
        ExternalConversation: { fields: [scalar("displayName"), scalar("participantNames")] },
        ExternalMessage: { fields: [scalar("senderName"), scalar("text"), scalar("raw", "Json")] },
        Message: { fields: [scalar("blocks", "Json"), scalar("replyQuote")] },
        Secret: { fields: [scalar("name")] },
        Artifact: { fields: [scalar("name")] },
        AgentSkill: { fields: [scalar("name")] },
      },
    },
    $extends: vi.fn((extension: { query: { $allModels: { $allOperations: Hook } } }) => {
      hook = extension.query.$allModels.$allOperations;
      return prisma;
    }),
  } as unknown as PrismaClient;
  withTextSanitization(prisma);
  if (!hook) throw new Error("Missing query hook");
  return hook;
}

describe("withTextSanitization", () => {
  it.each(["Secret", "Artifact", "AgentSkill"])(
    "preserves operational names for exact %s lookup",
    async (model) => {
      const hook = sanitizerHook();
      const name = "fixture\u202e";
      const args = { where: { name }, data: { name } };
      const result = { name };
      const query = vi.fn(async (_args: unknown) => result);
      expect(await hook({ model, operation: "update", args, query })).toBe(result);
      expect(query).toHaveBeenCalledWith(args);
      expect(query.mock.calls[0]?.[0]).toBe(args);
    },
  );
  it("cleans UTF-16 arguments before the query runs", async () => {
    const hook = sanitizerHook();
    const query = vi.fn(async (args: unknown) => args);
    await hook({ model: "Bot", operation: "create", args: { data: { prompt: "\0" } }, query });
    expect(query).toHaveBeenCalledWith({ data: { prompt: "�" } });
  });

  it.each([
    ["Bot", "name"],
    ["Space", "name"],
    ["User", "name"],
    ["ChatGroup", "name"],
    ["Page", "title"],
    ["ExternalConversation", "displayName"],
    ["ExternalMessage", "senderName"],
  ])("cleans %s.%s on writes", async (model, field) => {
    const query = vi.fn(async (_args: unknown) => null);
    const args = { data: { [field]: "\u202eAlice שלום 👩‍💻\u2069" } };
    await sanitizerHook()({ model, operation: "create", args, query });
    expect(query).toHaveBeenCalledWith({ data: { [field]: "Alice שלום 👩‍💻" } });
    expect(args.data[field]).toContain("\u202e");
  });

  it.each([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
  ])("covers mutation %s without changing filters", async (operation) => {
    const where = { name: "Alice\u202e" };
    const query = vi.fn(async (_args: unknown) => null);
    const args =
      operation === "upsert"
        ? { where, create: { name: "Alice\u202e" }, update: { name: { set: "Bob\u202e" } } }
        : { where, data: [{ name: "Alice\u202e" }] };
    await sanitizerHook()({ model: "Bot", operation, args, query });
    expect(query.mock.calls[0]?.[0]).toEqual(
      operation === "upsert"
        ? { where, create: { name: "Alice" }, update: { name: { set: "Bob" } } }
        : { where, data: [{ name: "Alice" }] },
    );
    expect((query.mock.calls[0]?.[0] as { where: unknown } | undefined)?.where).toBe(where);
  });

  it.each(["set", "push"])(
    "cleans list/string %s values, preserving JSON with identical keys",
    async (operator) => {
      const query = vi.fn(async (_args: unknown) => null);
      const raw = {
        name: "Alice\u202e",
        title: { set: "Page\u202e" },
        nested: { senderName: "Bob\u202e" },
      };
      await sanitizerHook()({
        model: "ExternalConversation",
        operation: "update",
        args: { data: { participantNames: { [operator]: ["Alice\u202e", "שלום"] } } },
        query,
      });
      expect(query).toHaveBeenLastCalledWith({
        data: { participantNames: { [operator]: ["Alice", "שלום"] } },
      });
      await sanitizerHook()({
        model: "Bot",
        operation: "create",
        args: { data: { metadata: raw } },
        query,
      });
      expect(query).toHaveBeenLastCalledWith({ data: { metadata: raw } });
      expect(
        (query.mock.calls[1]?.[0] as { data: { metadata: unknown } } | undefined)?.data.metadata,
      ).toBe(raw);
    },
  );

  it("cleans nested relation mutations, leaving nested filters and connect fields intact", async () => {
    const where = { name: "Alice\u202e" };
    const query = vi.fn(async (_args: unknown) => null);
    await sanitizerHook()({
      model: "Space",
      operation: "update",
      args: {
        data: {
          name: "Space\u202e",
          bots: {
            create: { name: "Alice\u202e" },
            createMany: { data: [{ name: "Bob\u202e" }] },
            update: { where, data: { name: { set: "Carol\u202e" } } },
            upsert: { where, create: { name: "Dan\u202e" }, update: { name: "Eve\u202e" } },
            connect: where,
          },
        },
      },
      query,
    });
    expect(query).toHaveBeenCalledWith({
      data: {
        name: "Space",
        bots: {
          create: { name: "Alice" },
          createMany: { data: [{ name: "Bob" }] },
          update: { where, data: { name: { set: "Carol" } } },
          upsert: { where, create: { name: "Dan" }, update: { name: "Eve" } },
          connect: where,
        },
      },
    });
  });

  it("keeps message bodies and all JSON labels verbatim except existing UTF-16 protections", async () => {
    const hook = sanitizerHook();
    const query = vi.fn(async (_args: unknown) => null);
    const blocks = [
      { kind: "text", text: "שלום\u202e" },
      { kind: "channel_message", fromLabel: "Alice\u202e" },
    ];
    await hook({
      model: "Message",
      operation: "create",
      args: { data: { blocks, replyQuote: "\u202equoted" } },
      query,
    });
    expect(query).toHaveBeenCalledWith({ data: { blocks, replyQuote: "\u202equoted" } });
    const raw = { name: "Alice\u202e", text: "body\u202e\0" };
    await hook({
      model: "ExternalMessage",
      operation: "create",
      args: { data: { senderName: "Alice\u202e", text: "body\u202e", raw } },
      query,
    });
    expect(query).toHaveBeenLastCalledWith({
      data: {
        senderName: "Alice",
        text: "body\u202e",
        raw: { name: "Alice\u202e", text: "body\u202e�" },
      },
    });
  });

  it("projects existing names and nested results without rewriting records or JSON", async () => {
    const hook = sanitizerHook();
    const metadata = { name: "JSON\u202e", senderName: "Alice\u202e" };
    const result = [
      { name: "Space\u202e", bots: [{ name: "Alice\u202e", prompt: "body\u202e", metadata }] },
    ];
    const args = { where: { name: "Space\u202e" } };
    const query = vi.fn(async (_args: unknown) => result);
    const projected = await hook({ model: "Space", operation: "findMany", args, query });
    expect(query).toHaveBeenCalledWith(args);
    expect(projected).toEqual([
      { name: "Space", bots: [{ name: "Alice", prompt: "body\u202e", metadata }] },
    ]);
    expect(result[0]?.name).toBe("Space\u202e");
    expect((projected as typeof result)[0]?.bots[0]?.metadata).toBe(metadata);
    const clean = { name: "Alice" };
    expect(
      await hook({ model: "Bot", operation: "findUnique", args: {}, query: async () => clean }),
    ).toBe(clean);
  });
});
