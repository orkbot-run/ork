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
