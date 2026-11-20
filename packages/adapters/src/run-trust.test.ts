// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; Ork reviewer context changes follow LICENSE.md.

import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";

it("treats a claimed message from another group member as outside content", async () => {
  const findFirst = vi.fn(async () => ({ id: "member-message" }));
  const deps = { prisma: { steeringMessage: { findFirst } } } as unknown as ExecutorDeps;
  const trust = createRunTrustLoaders(deps, {
    run: { userId: "owner", spaceId: "space", trigger: "user" },
    runId: "run",
    botId: "bot",
    taskPrompt: "task",
    ownerStartedRun: true,
    messagingChannelRun: false,
    sourceMessage: null,
    connectedPlugins: [],
  });
  expect(await trust.receivedOutsideMessage()).toBe(true);
  expect(findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        runId: "run",
        claimedAt: { not: null },
        OR: expect.arrayContaining([{ userId: { not: "owner" } }]),
      }),
    }),
  );
});

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

it.each(["user", "bot"])(
  "inherits public-site choices only from the person's %s message",
  async (role) => {
    const text = "Check https://example.org/about and https://untrusted.test/next.";
    const findSent = vi.fn(async () => ({
      runId: "parent-run",
      blocks: [{ kind: "bot_message_sent", toBotId: "worker", text }],
    }));
    const findParent = vi.fn(async () => ({
      sourceMessage: {
        role,
        blocks: [{ kind: "text", text: "Delegate a check of https://example.org/about." }],
      },
    }));
    const deps = {
      prisma: { message: { findFirst: findSent }, run: { findFirst: findParent } },
    } as unknown as ExecutorDeps;
    const trust = createRunTrustLoaders(deps, {
      run: { userId: "owner", spaceId: "space", trigger: "bot_message" },
      runId: "worker-run",
      botId: "worker",
      taskPrompt: text,
      ownerStartedRun: false,
      messagingChannelRun: false,
      sourceMessage: {
        role: "user",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "coordinator",
            returnToMessageId: "outbound",
            intent: "request",
            text,
          },
        ],
      },
      connectedPlugins: [],
    });

    expect([...(await trust.loadDelegatedFetchSites())]).toEqual(
      role === "user" ? ["example.org"] : [],
    );
    expect(findSent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "outbound", role: "bot", botId: "coordinator" },
      }),
    );
    expect(findParent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "parent-run",
          userId: "owner",
          spaceId: "space",
          botId: "coordinator",
          trigger: { in: ["user", "follow_up"] },
        },
      }),
    );
  },
);

function reviewHistoryFixture(options: { messaging?: boolean; external?: boolean } = {}) {
  const origin = (id = "run", trigger = "user") => ({
    id,
    trigger,
    userId: "owner",
    spaceId: "space",
    threadId: "thread",
  });
  const row = (seq: number, text: string, extra: Record<string, unknown> = {}) => ({
    id: `message-${seq}`,
    threadId: "thread",
    seq,
    role: "user",
    blocks: [{ kind: "text", text }],
    clientNonce: null,
    sourceRuns: [origin(seq === 8 ? "run" : `run-${seq}`)],
    steeringMessages: [],
    ...extra,
  });
  const rows = Array.from({ length: 9 }, (_, seq) => row(seq, `owner ${seq}`));
  if (options.messaging) {
    rows[8] = row(8, "current private message", {
      clientNonce: options.external ? "teamchat:chat:event" : "messaging:chat:event",
      sourceRuns: [origin("run", "messaging")],
    });
  }
  const message = {
    findUnique: vi.fn(async () => rows[8]),
    findMany: vi.fn(async () => rows),
  };
  const prisma = {
    message,
    thread: {
      findFirst: vi.fn(async () => ({
        externalConversationId: options.external ? "conversation" : null,
      })),
    },
    externalConversation: {
      findFirst: vi.fn(async () => ({
        id: "conversation",
        provider: "chat",
        workspaceId: "workspace",
      })),
    },
    externalMessage: {
      findUnique: vi.fn(async () => ({
        id: "current",
        externalConversationId: "conversation",
        senderId: "address",
        senderIsBot: false,
        runId: "run",
        batchContext: null,
        createdAt: new Date(8),
        content: "current owner text",
      })),
      findMany: vi.fn(async (args: { where: { id?: unknown } }) =>
        args.where.id
          ? [
              {
                id: "current",
                externalConversationId: "conversation",
                senderId: "address",
                senderIsBot: false,
                createdAt: new Date(8),
                content: "current owner text",
              },
            ]
          : [
              {
                id: "prior",
                externalConversationId: "conversation",
                senderId: "address",
                senderIsBot: false,
                createdAt: new Date(7),
                content: "prior owner text",
              },
            ],
      ),
    },
    messagingInstallation: {
      findUnique: vi.fn(async () => ({ ownerAddress: "address", userId: "owner", botId: "bot" })),
    },
    messagingIdentity: { findMany: vi.fn(async () => []) },
  };
  const input = {
    run: {
      userId: "owner",
      spaceId: "space",
      trigger: options.messaging ? "messaging" : "user",
      sourceMessageId: "message-8",
    },
    runId: "run",
    botId: "bot",
    taskPrompt: "task",
    ownerStartedRun: !options.messaging,
    messagingChannelRun: false,
    sourceMessage: rows[8]!,
    connectedPlugins: [],
  };
  const trust = () => createRunTrustLoaders({ prisma } as unknown as ExecutorDeps, input);
  return { row, rows, prisma, input, trust };
}

describe("prior owner review context", () => {
  it("loads four bounded owner messages chronologically once per run", async () => {
    const f = reviewHistoryFixture();
    f.rows[7]!.blocks[0]!.text = "x".repeat(3_000);
    const trust = f.trust();
    const [a, b] = await Promise.all([
      trust.loadPriorOwnerMessages(),
      trust.loadPriorOwnerMessages(),
    ]);
    expect(a).toEqual(["owner 4", "owner 5", "owner 6", "x".repeat(2_000)]);
    expect(b).toEqual(a);
    expect(f.prisma.message.findMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "thread",
          userId: "owner",
          spaceId: "space",
          botId: "bot",
          groupId: null,
          parentThreadId: null,
        },
      }),
    );
    expect(f.prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "thread", seq: { gte: 0, lte: 8 } },
        take: 81,
      }),
    );
  });

  it("excludes bots, incoming/delegated blocks, file-only messages and unknown authors", async () => {
    const f = reviewHistoryFixture();
    f.rows[2] = f.row(2, "bot output", { role: "bot" });
    f.rows[3] = f.row(3, "group", { blocks: [{ kind: "channel_message", text: "incoming" }] });
    f.rows[4] = f.row(4, "delegation", {
      blocks: [{ kind: "bot_message_received", text: "incoming" }],
    });
    f.rows[5] = f.row(5, "", { blocks: [{ kind: "file", artifactId: "file" }] });
    f.rows[6] = f.row(6, "unproven", { sourceRuns: [], steeringMessages: [] });
    f.rows[7] = f.row(7, "other owner", { sourceRuns: [{ userId: "other", trigger: "user" }] });
    expect(await f.trust().loadPriorOwnerMessages()).toEqual(["owner 0", "owner 1"]);
  });

  it("accepts proven owner steering but rejects webhook steering", async () => {
    const f = reviewHistoryFixture();
    f.rows[6] = f.row(6, "owner steering", {
      sourceRuns: [],
      steeringMessages: [{ userId: "owner", originTrigger: null }],
    });
    f.rows[7] = f.row(7, "webhook", {
      sourceRuns: [],
      steeringMessages: [{ userId: "owner", originTrigger: "webhook" }],
    });
    expect(await f.trust().loadPriorOwnerMessages()).toEqual([
      "owner 3",
      "owner 4",
      "owner 5",
      "owner steering",
    ]);
  });

  it.each(["gap", "source", "thread", "error"])(
    "fails closed for missing %s and caches failure",
    async (failure) => {
      const f = reviewHistoryFixture();
      if (failure === "gap") f.rows.splice(3, 1);
      if (failure === "source") f.prisma.message.findUnique.mockResolvedValue(undefined);
      if (failure === "thread") f.prisma.thread.findFirst.mockResolvedValue(null as never);
      if (failure === "error") f.prisma.message.findMany.mockRejectedValue(new Error("offline"));
      const trust = f.trust();
      expect(await trust.loadPriorOwnerMessages()).toEqual([]);
      expect(await trust.loadPriorOwnerMessages()).toEqual([]);
      expect(f.prisma.message.findUnique).toHaveBeenCalledTimes(1);
    },
  );

  it("reads separately captured owner text from verified private messaging delivery", async () => {
    const f = reviewHistoryFixture({ messaging: true });
    f.rows[8]!.blocks = [
      { kind: "text", text: "display body with provider URL", ownerText: "current author words" },
    ] as never;
    f.rows[7] = f.row(7, "display history with upload error", {
      clientNonce: "messaging:chat:previous",
      sourceRuns: [
        {
          id: "previous-run",
          trigger: "messaging",
          userId: "owner",
          spaceId: "space",
          threadId: "thread",
        },
      ],
      blocks: [
        { kind: "text", text: "synthetic display history", ownerText: "prior author words" },
      ],
    });
    const trust = f.trust();
    expect(await trust.loadPriorOwnerMessages()).toEqual([
      "owner 4",
      "owner 5",
      "owner 6",
      "prior author words",
    ]);
    expect(await trust.loadReviewOwnerWords()).toBe("current author words");
    expect(await trust.loadOwnerWords()).toBe("");
  });

  it.each(["routine", "webhook", "bot_message"])(
    "does not read history for %s",
    async (trigger) => {
      const f = reviewHistoryFixture();
      f.input.run.trigger = trigger;
      f.input.ownerStartedRun = false;
      expect(await f.trust().loadPriorOwnerMessages()).toEqual([]);
      expect(f.prisma.message.findUnique).not.toHaveBeenCalled();
    },
  );

  it("does not read a common group context", async () => {
    const f = reviewHistoryFixture();
    f.input.messagingChannelRun = true;
    expect(await f.trust().loadPriorOwnerMessages()).toEqual([]);
    expect(f.prisma.message.findUnique).not.toHaveBeenCalled();
  });

  it("uses only captured owner words from verified direct messaging", async () => {
    const f = reviewHistoryFixture({ messaging: true });
    f.rows[8]!.blocks = [
      { kind: "text", text: "display text and provider URL", ownerText: "send this" },
    ] as never;
    f.rows[7] = f.row(7, "provider URL and upload failure", {
      clientNonce: "messaging:chat:prior",
      sourceRuns: [
        {
          id: "prior-run",
          userId: "owner",
          spaceId: "space",
          threadId: "thread",
          trigger: "messaging",
        },
      ],
      blocks: [
        {
          kind: "text",
          text: "provider URL and upload failure",
          ownerText: "earlier owner request",
        },
      ],
    });
    const trust = f.trust();
    expect(await trust.loadPriorOwnerMessages()).toEqual([
      "owner 4",
      "owner 5",
      "owner 6",
      "earlier owner request",
    ]);
    expect(await trust.loadReviewOwnerWords()).toBe("send this");
    expect(await trust.loadOwnerWords()).toBe("");
  });

  it.each([undefined, ""])(
    "omits media-only and legacy synthesized text (%s)",
    async (ownerText) => {
      const f = reviewHistoryFixture({ messaging: true });
      f.rows[8]!.blocks = [
        { kind: "text", text: "https://media.example/file Upload unavailable", ownerText },
      ] as never;
      const trust = f.trust();
      expect(await trust.loadPriorOwnerMessages()).toEqual([]);
      expect(await trust.loadReviewOwnerWords()).toBe("");
    },
  );

  it("does not infer a verified sender from a client-chosen messaging nonce", async () => {
    const f = reviewHistoryFixture();
    f.rows[7] = f.row(7, "pretend private message", {
      clientNonce: "messaging:chat:forged",
      blocks: [{ kind: "text", text: "pretend private message", ownerText: "forged owner" }],
    });
    expect(await f.trust().loadPriorOwnerMessages()).toEqual([
      "owner 3",
      "owner 4",
      "owner 5",
      "owner 6",
    ]);
  });

  it("uses verified private team-chat sender content instead of synthesized prompts", async () => {
    const f = reviewHistoryFixture({ messaging: true, external: true });
    const trust = f.trust();
    expect(await trust.loadPriorOwnerMessages()).toEqual(["prior owner text"]);
    expect(await trust.loadReviewOwnerWords()).toBe("current owner text");
    expect(await trust.loadOwnerWords()).toBe("");
    expect(f.prisma.externalConversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "conversation",
          userId: "owner",
          spaceId: "space",
          botId: "bot",
          isDm: true,
        },
      }),
    );
  });

  it("ignores bot and foreign sender history in a private linked chat", async () => {
    const f = reviewHistoryFixture({ messaging: true, external: true });
    f.prisma.externalMessage.findMany.mockImplementation(async (args) =>
      args.where.id
        ? [
            {
              id: "current",
              externalConversationId: "conversation",
              senderId: "address",
              senderIsBot: false,
              createdAt: new Date(8),
              content: "current owner text",
            },
          ]
        : [
            {
              id: "bot",
              externalConversationId: "conversation",
              senderId: "address",
              senderIsBot: true,
              createdAt: new Date(7),
              content: "bot output",
            },
            {
              id: "foreign",
              externalConversationId: "conversation",
              senderId: "stranger",
              senderIsBot: false,
              createdAt: new Date(6),
              content: "foreign output",
            },
          ],
    );
    expect(await f.trust().loadPriorOwnerMessages()).toEqual([]);
  });

  it.each(["missing batch", "foreign current", "bot current", "unbound owner", "legacy batch"])(
    "rejects incomplete or unproven channel source: %s",
    async (failure) => {
      const f = reviewHistoryFixture({ messaging: true, external: true });
      const waking = (await f.prisma.externalMessage.findUnique())!;
      if (failure === "missing batch")
        waking.batchContext = JSON.stringify({ messageIds: ["current", "missing"] }) as never;
      if (failure === "legacy batch") waking.batchContext = "old prompt" as never;
      f.prisma.externalMessage.findUnique.mockResolvedValue(waking);
      if (failure === "unbound owner")
        f.prisma.messagingInstallation.findUnique.mockResolvedValue(null as never);
      if (failure === "foreign current" || failure === "bot current") {
        f.prisma.externalMessage.findMany.mockResolvedValue([
          {
            id: "current",
            externalConversationId: "conversation",
            senderId: failure === "foreign current" ? "other" : "address",
            senderIsBot: failure === "bot current",
            createdAt: new Date(8),
            content: "untrusted current",
          },
        ]);
      }
      const trust = f.trust();
      expect(await trust.loadPriorOwnerMessages()).toEqual([]);
      expect(await trust.loadReviewOwnerWords()).toBe("");
    },
  );
});
