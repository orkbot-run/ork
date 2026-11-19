// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { threadLiveActivities } from "./run-live-activity.js";

const running = (id: string, threadId: string) => ({ id, status: "running", threadId });

function database(payloads: Record<string, unknown>) {
  const $queryRaw = vi.fn(async (query: { values: unknown[] }) => {
    const ids = query.values[0] as string[];
    const threadIds = query.values[1] as string[];
    return ids.flatMap((runId, index) =>
      runId in payloads
        ? [
            {
              id: `event-${runId}`,
              runId,
              threadId: threadIds[index],
              spaceId: "space",
              payload: payloads[runId],
            },
          ]
        : [],
    );
  });
  return { prisma: { $queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">, $queryRaw };
}

async function activity(payload: unknown) {
  return (
    await threadLiveActivities(database({ run: payload }).prisma, [
      { threadId: "chat", runs: [running("run", "chat")] },
    ])
  ).get("chat");
}

describe("roster live activity", () => {
  it("batches running chats and cleans and bounds the newest step", async () => {
    const { prisma, $queryRaw } = database({
      first: { activity: true, text: " Reading \n the brief  " },
      second: { streaming: true, delta: "Reply" },
    });
    expect(
      await threadLiveActivities(prisma, [
        { threadId: "one", runs: [running("first", "one")] },
        { threadId: "two", runs: [running("second", "two")] },
      ]),
    ).toEqual(
      new Map([
        ["one", { kind: "step", text: "Reading the brief" }],
        ["two", { kind: "writing" }],
      ]),
    );
    expect($queryRaw).toHaveBeenCalledTimes(1);
    const step = await activity({ activity: true, text: "x".repeat(200) });
    expect(step?.kind === "step" && step.text.length).toBeLessThanOrEqual(120);
  });

  it("respects explicit clears, unreadable payloads and non-streaming notices", async () => {
    for (const payload of [
      null,
      [],
      {},
      { text: "Stopped" },
      { activity: true, text: "" },
      { activity: true, text: " \n " },
      { streaming: true, delta: "" },
    ]) {
      expect(await activity(payload)).toBeUndefined();
    }
    expect(await activity({ streaming: true, text: "Reply" })).toEqual({ kind: "writing" });
    expect(await activity({ streaming: true, delta: " " })).toEqual({ kind: "writing" });
  });

  it("selects only the chat's own primary run", async () => {
    const { prisma, $queryRaw } = database({
      own: { activity: true, text: "Reading" },
      group: { activity: true, text: "Group secret" },
    });
    expect(
      await threadLiveActivities(prisma, [
        { threadId: "chat", runs: [running("group", "group-chat"), running("own", "chat")] },
      ]),
    ).toEqual(new Map([["chat", { kind: "step", text: "Reading" }]]));
    expect($queryRaw.mock.calls[0]?.[0].values).toEqual([["own"], ["chat"]]);
  });

  it("does no event read for inactive, missing, group-only or waiting chats", async () => {
    const { prisma, $queryRaw } = database({});
    expect(
      await threadLiveActivities(prisma, [
        { threadId: "idle", runs: [] },
        { threadId: undefined, runs: [running("missing", "chat")] },
        { threadId: "chat", runs: [running("group", "group-chat")] },
        {
          threadId: "waiting",
          runs: [
            { id: "wait", threadId: "waiting", status: "waiting_input" },
            running("older", "waiting"),
          ],
        },
        { threadId: "queued", runs: [{ id: "queue", threadId: "queued", status: "queued" }] },
      ]),
    ).toEqual(new Map());
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
