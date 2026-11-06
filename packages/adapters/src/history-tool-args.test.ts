// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { validateToolArguments } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { toAgentTools } from "./pi-runtime-tools.js";
import { memoryTools } from "./run-tools-memory.js";

const readers = vi.hoisted(() => ({ searchHistory: vi.fn(), readHistory: vi.fn() }));
vi.mock("@orkbot/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...readers,
}));

const defs = builtinAgentTools.filter((tool) =>
  ["search_history", "read_history"].includes(tool.name),
);
function prepared(name: string, args: unknown) {
  const tool = toAgentTools(defs, {} as never).find((tool) => tool.name === name)!;
  const normalized = tool.prepareArguments!(args);
  return validateToolArguments(tool, {
    type: "toolCall",
    id: "call-1",
    name,
    arguments: normalized as never,
  });
}

function fakeRun(myChatsAllowed = false, outsideMessage = false) {
  const receivedOutsideMessage = vi.fn(async () => outsideMessage);
  const copyEarlierFiles = vi.fn();
  const ctx = {
    deps: { prisma: {} },
    run: {
      spaceId: "space-1",
      userId: "user-1",
      threadId: "thread-1",
      botId: "bot-1",
      createdAt: new Date("2026-01-01Z"),
    },
    source: { myChatsAllowed },
    trust: { receivedOutsideMessage },
    computer: { copyEarlierFiles },
    secrets: [],
  };
  const call = (name: string, args: Record<string, unknown>) =>
    memoryTools[name]!(
      ctx as never,
      {
        name,
        args,
        finish: async (result: unknown) => result,
      } as never,
    );
  return { call, receivedOutsideMessage, copyEarlierFiles };
}

beforeEach(() => {
  vi.clearAllMocks();
  readers.searchHistory.mockResolvedValue({ messages: [] });
  readers.readHistory.mockResolvedValue({ messages: [] });
});

describe("history arguments before runtime validation", () => {
  it("normalizes model inputs before the runtime's canonical schema check", () => {
    expect(
      prepared("search_history", {
        query: "Aurora",
        queries: "orbit",
        before: "",
        scope: null,
        limit: null,
      }),
    ).toEqual({ queries: ["Aurora", "orbit"] });
    expect(prepared("search_history", { query: "Aurora", queries: null, beforeSeq: 0 })).toEqual({
      query: "Aurora",
      beforeSeq: 0,
    });
    expect(
      prepared("read_history", {
        messageId: "message-1",
        threadId: " ",
        linkedRunId: null,
        textOffset: 0,
        direction: "",
      }),
    ).toEqual({ messageId: "message-1", textOffset: 0 });
  });

  it("reports corrections before runtime validation without a JSON schema dump", () => {
    expect(() => prepared("search_history", { query: "Aurora", before: "yesterday" })).toThrow(
      "before: Use an ISO date",
    );
    expect(() => prepared("read_history", { messageId: null })).toThrow("messageId:");
    expect(() =>
      prepared("search_history", { query: "a", queries: ["b", "c", "d", "e", "f"] }),
    ).toThrow("queries:");
  });
});

describe("history tool execution", () => {
  it("passes folded queries and normalized dates to retrieval", async () => {
    const { call } = fakeRun();
    await call("search_history", {
      query: "Aurora",
      queries: ["orbit"],
      before: "2026-01-01",
      botId: null,
    });
    expect(readers.searchHistory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ allowMyChats: false }),
      { queries: ["Aurora", "orbit"], before: "2026-01-01T00:00:00.000Z" },
    );
  });

  it("returns one correction per field before probing trust or reading history", async () => {
    const { call, receivedOutsideMessage } = fakeRun(true);
    const result = await call("search_history", {
      query: "Aurora",
      scope: "my_chats",
      before: "yesterday",
      limit: -1,
    });
    expect(result).toEqual({
      error: expect.stringMatching(/^before: Use an ISO date[^\n]+\nlimit: /),
    });
    expect(readers.searchHistory).not.toHaveBeenCalled();
    expect(receivedOutsideMessage).not.toHaveBeenCalled();
    await expect(call("read_history", { messageId: "", threadId: "other" })).resolves.toEqual({
      error: expect.stringContaining("messageId:"),
    });
    expect(readers.readHistory).not.toHaveBeenCalled();
  });

  it("treats an empty thread as local without requesting cross-chat access", async () => {
    const { call, receivedOutsideMessage } = fakeRun(true);
    await call("read_history", { messageId: "message-1", threadId: " ", attachmentOffset: 0 });
    expect(readers.readHistory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ allowMyChats: false }),
      { messageId: "message-1", attachmentOffset: 0 },
    );
    expect(receivedOutsideMessage).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, false],
    [true, false, true],
    [true, true, false],
  ])("keeps cross-chat authorization: grant=%s outside=%s", async (grant, outside, allowed) => {
    const { call } = fakeRun(grant, outside);
    await call("search_history", { query: "Aurora", scope: "my_chats", before: null });
    expect(readers.searchHistory).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ allowMyChats: allowed }),
      { query: "Aurora", scope: "my_chats" },
    );
    await call("read_history", { messageId: "message-1", threadId: "other-thread" });
    expect(readers.readHistory).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({ allowMyChats: allowed }),
      { messageId: "message-1", threadId: "other-thread" },
    );
  });
});
