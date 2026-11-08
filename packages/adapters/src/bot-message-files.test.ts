// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ArtifactStore, ComputerRef, SandboxProvider } from "@orkbot/adapter-kit";
import { approvalEffectKey } from "@orkbot/core/node/approval-effect-key";
import type { Artifact, Computer, Prisma, PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { botFilePaths, delegatedFilesInstruction, prepareBotFiles } from "./bot-message-files.js";
import { messageBot } from "./bot-messages.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { handoffToGroupBot } from "./group-handoff.js";
import { resolveToolRequest } from "./run-tool-request.js";

const run = { id: "run", botId: "sender", threadId: "source", spaceId: "space", userId: "user" };
function fixture(shared = false) {
  const context = {
    ...run,
    runId: run.id,
    operationId: "op",
    traceId: "trace",
    signal: new AbortController().signal,
  };
  let current = {
    id: "computer",
    spaceId: "space",
    scope: shared ? "team" : "dedicated",
    homeKey: "home",
    kind: "fake",
    providerRef: "fixture-computer",
    screenGeneration: 2,
  } as Computer;
  const rows: Artifact[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let loseCommitResponse = false;
  const objects = new Map<string, Uint8Array>();
  const target = {
    botId: "receiver",
    threadId: "target",
    computerId: shared ? current.id : "other-computer",
  };
  const read = vi.fn(async () => new TextEncoder().encode("content"));
  const put = vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
    const id = `blob-${objects.size}`;
    objects.set(id, bytes);
    return { id, hash: "hash" };
  });
  const remove = vi.fn(async (id: string) => {
    objects.delete(id);
  });
  const prisma = {
    $queryRaw: vi.fn(async () => [{ id: "group" }]),
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot" })),
      findMany: vi.fn(async () => [
        {
          id: target.botId,
          name: "Receiver",
          computerId: target.computerId,
          thread: { id: target.threadId },
        },
      ]),
    },
    run: {
      findFirst: vi.fn(async () => ({
        id: run.id,
        thread: { groupId: null },
        sourceMessage: { blocks: [] },
      })),
      findUnique: vi.fn(async () => ({ status: "running", leaseOwner: "worker", leaseFence: 1 })),
      create: vi.fn(async () => ({ id: "recipient-run" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    message: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          messages.find((item) => item.clientNonce === where.clientNonce) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { threadId_clientNonce?: { clientNonce: string } } }) => {
          const found = messages.find(
            (item) => item.clientNonce === where.threadId_clientNonce?.clientNonce,
          );
          return found
            ? { ...found, sourceRuns: [{ id: "recipient-run", botId: target.botId }] }
            : null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const message = { id: `message-${messages.length}`, ...data };
        messages.push(message);
        return message;
      }),
      update: vi.fn(async () => ({})),
    },
    task: { create: vi.fn(async () => ({ id: "task" })) },
    thread: {
      update: vi.fn(async ({ select }: { select: { nextMessageSeq?: boolean } }) =>
        select.nextMessageSeq
          ? { nextMessageSeq: messages.length + 1 }
          : { nextEventSeq: events.length + 1 },
      ),
    },
    chatGroup: {
      findFirst: vi.fn(async () => ({
        id: "group",
        name: "Group",
        thread: { id: target.threadId },
        members: [
          { bot: { id: run.botId, name: "Sender", computerId: current.id } },
          { bot: { id: target.botId, name: "Receiver", computerId: target.computerId } },
        ],
      })),
      update: vi.fn(async () => ({})),
    },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const value = { id: `event-${events.length}`, ...data };
        events.push(value);
        return value;
      }),
      findFirst: vi.fn(async () => ({ seq: events.length })),
    },
    computer: { findFirst: vi.fn(async () => current) },
    artifact: {
      findMany: vi.fn(async () => [...rows]),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.storageKey)
          return rows.find((row) => row.storageKey === where.storageKey) ?? null;
        if (where.clientNonce)
          return rows.find((row) => row.clientNonce === where.clientNonce) ?? null;
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `artifact-${rows.length}`,
          ...data,
          groupId: data.groupId ?? null,
        } as Artifact;
        rows.push(row);
        return row;
      }),
    },
  };
  const transaction = vi.fn(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const result = await callback(prisma as unknown as Prisma.TransactionClient);
      if (loseCommitResponse) throw new Error("lost commit response");
      return result;
    },
  );
  const database = { ...prisma, $transaction: transaction };
  const deps = {
    runLease: { runId: run.id, owner: "worker", fence: 1 },
    prisma: database as unknown as PrismaClient,
    sandbox: {
      readTransferFile: read,
      sharesWorkspace: () => shared,
    } as unknown as SandboxProvider,
    artifacts: { put, remove } as unknown as ArtifactStore,
    maxUploadSizeBytes: 1024,
    events: { notify: vi.fn(async () => undefined) },
    jobs: { enqueue: vi.fn(async () => undefined) },
  };
  const source = {
    computerId: current.id,
    mode: shared ? ("team" as const) : ("dedicated" as const),
    context,
    computer: vi.fn(
      async () =>
        ({
          id: "ref",
          botId: current.homeKey,
          kind: current.kind,
          providerRef: current.providerRef,
        }) as ComputerRef,
    ),
  };
  const prepare = (files = ["report.txt"], key = "delivery") =>
    prepareBotFiles(deps, run, target, files, key, source);
  return {
    deps,
    prisma,
    target,
    source,
    rows,
    messages,
    events,
    objects,
    put,
    remove,
    read,
    prepare,
    get computerSnapshot() {
      return current;
    },
    tx: prisma as unknown as Prisma.TransactionClient,
    lostCommit: () => {
      loseCommitResponse = true;
    },
    replace: () => {
      current = { ...current, screenGeneration: current.screenGeneration + 1 };
    },
  };
}

it.each(["message_bot", "handoff_to_bot"])("offers bounded optional files in %s", (name) => {
  const schema = builtinAgentTools.find((tool) => tool.name === name)!.inputSchema;
  expect(schema.properties).toHaveProperty(
    "files",
    expect.objectContaining({ type: "array", maxItems: 4 }),
  );
});

describe("bounded bot file preparation", () => {
  it("does not touch storage or source for an absent file list", async () => {
    const f = fixture();
    expect(await f.prepare([])).toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([["../escape.txt"], ["bad\0name"], Array(5).fill("a.txt"), ["x".repeat(4097)]])(
    "rejects malformed paths before IO: %j",
    (paths) => {
      expect(() => botFilePaths(paths)).toThrow();
    },
  );
  it("commits ordinary attachment artifacts only in the delivery transaction", async () => {
    const f = fixture();
    const prepared = (await f.prepare())!;
    expect(f.rows).toEqual([]);
    expect(f.put).toHaveBeenCalledOnce();
    const blocks = await prepared.commit(f.tx);
    expect(blocks).toEqual([
      {
        kind: "file",
        artifactId: "artifact-0",
        name: "report.txt",
        mimeType: "text/plain",
        size: 7,
      },
    ]);
    expect(f.rows[0]).toMatchObject({
      botId: "receiver",
      spaceId: "space",
      userId: "user",
      runId: "run",
      clientNonce: "bot-files:delivery:0",
    });
    await prepared.cleanup(true);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("reuses the first snapshot without rereading changed or unavailable source files", async () => {
    const f = fixture();
    const first = (await f.prepare())!;
    const original = await first.commit(f.tx);
    f.read.mockRejectedValue(new Error("source removed"));
    const retry = (await f.prepare())!;
    expect(await retry.commit(f.tx)).toEqual(original);
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.put).toHaveBeenCalledOnce();
  });
  it("refuses an existing nonce for a different recipient before source IO", async () => {
    const f = fixture();
    f.rows.push({
      clientNonce: "bot-files:delivery:0",
      runId: "run",
      botId: "other",
      groupId: null,
    } as Artifact);
    await expect(f.prepare()).rejects.toThrow("different recipient");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps a shared Team reference only with explicit namespace capability", async () => {
    const f = fixture(true);
    const prepared = (await f.prepare())!;
    expect(prepared.workspaceFiles).toMatchObject({
      computerId: "computer",
      paths: ["bots/sender/report.txt"],
    });
    expect(await prepared.commit(f.tx)).toEqual([]);
    expect(f.put).not.toHaveBeenCalled();
    f.deps.sandbox.sharesWorkspace = () => false;
    const copied = (await f.prepare())!;
    expect(copied.workspaceFiles).toBeUndefined();
    expect(await copied.commit(f.tx)).toHaveLength(1);
  });
  it("rejects a replacement computer before publishing prepared bytes", async () => {
    const f = fixture();
    const prepared = (await f.prepare())!;
    f.replace();
    await expect(prepared.commit(f.tx)).rejects.toThrow("computer changed");
    await prepared.cleanup(true);
    expect(f.rows).toEqual([]);
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it("retains bytes after an unknown COMMIT outcome even when a read cannot yet see metadata", async () => {
    const f = fixture();
    const prepared = (await f.prepare())!;
    await prepared.commit(f.tx);
    f.rows.splice(0);
    await prepared.cleanup();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.objects.size).toBe(1);
  });
  it("removes only its own losing object after a confirmed concurrent replay", async () => {
    const f = fixture();
    const a = (await f.prepare())!;
    const b = (await f.prepare())!;
    await a.commit(f.tx);
    await b.commit(f.tx);
    await b.cleanup(true);
    expect(f.rows).toHaveLength(1);
    expect(f.objects.has(f.rows[0]!.storageKey)).toBe(true);
    expect(f.remove).toHaveBeenCalledWith("blob-1", expect.anything());
  });
  it("cleans earlier objects when a later source fails before any transaction starts", async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockRejectedValueOnce(new Error("unavailable"));
    await expect(f.prepare(["one.txt", "two.txt"])).rejects.toThrow();
    expect(f.rows).toEqual([]);
    expect(f.objects.size).toBe(0);
  });

  it("refuses an adapter without a source-bounded read instead of using ordinary readFile", async () => {
    const f = fixture();
    f.deps.sandbox.readTransferFile = undefined;
    f.deps.sandbox.readFile = vi.fn();
    await expect(f.prepare()).rejects.toThrow("unsupported on this computer");
    expect(f.deps.sandbox.readFile).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("preserves a concurrent winner even when both puts return the same storage key", async () => {
    const f = fixture();
    const first = (await f.prepare())!;
    f.put.mockResolvedValueOnce({ id: "blob-0", hash: "hash" });
    const other = (await f.prepare())!;
    await first.commit(f.tx);
    await other.commit(f.tx);
    await other.cleanup(true);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("retires a late successful put after source cancellation without publishing metadata", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.source.context.signal = controller.signal;
    let complete!: (value: { id: string; hash: string }) => void;
    f.put.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const preparing = f.prepare();
    await vi.waitFor(() => expect(f.put).toHaveBeenCalledOnce());
    controller.abort(new Error("source retired"));
    await expect(preparing).rejects.toThrow("source retired");
    complete({ id: "late-blob", hash: "hash" });
    await vi.waitFor(() => expect(f.remove).toHaveBeenCalledWith("late-blob", expect.anything()));
    expect(f.rows).toEqual([]);
  });

  it("checks shared-reference source ownership and computer generation again at the receiver", async () => {
    const f = fixture(true);
    const prepared = (await f.prepare())!;
    const blocks = [
      {
        kind: "bot_message_received" as const,
        fromBotId: "sender",
        fromBotName: "Sender",
        text: "Review",
        workspaceFiles: prepared.workspaceFiles,
      },
    ];
    const receiving = { ...run, botId: "receiver", threadId: "target" };
    expect(
      await delegatedFilesInstruction(f.deps, receiving, f.computerSnapshot, blocks),
    ).toContain('"/bots/sender/report.txt"');
    expect(f.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "sender",
          spaceId: "space",
          userId: "user",
          computerId: "computer",
        }),
      }),
    );
    f.replace();
    expect(
      await delegatedFilesInstruction(f.deps, receiving, f.computerSnapshot, blocks),
    ).toContain("no longer available");
  });

  it("treats malformed stored shared references as unavailable data instead of crashing the receiver", async () => {
    const f = fixture(true);
    const prepared = (await f.prepare())!;
    const blocks = [
      {
        kind: "bot_message_received" as const,
        fromBotId: "sender",
        fromBotName: "Sender",
        text: "Review",
        workspaceFiles: { ...prepared.workspaceFiles!, paths: ["bad\0path"] },
      },
    ];
    expect(
      await delegatedFilesInstruction(
        f.deps,
        { ...run, botId: "receiver" },
        f.computerSnapshot,
        blocks,
      ),
    ).toContain("invalid");
  });
});

describe("delegation delivery integration", () => {
  it.each(["message_bot", "handoff_to_bot"])(
    "keeps files inside canonical approval/replay arguments for %s",
    async (name) => {
      const original = { bot_id: "receiver", message: "Review", files: ["approved.txt"] };
      const key = approvalEffectKey("run", name, original);
      const changed = { ...original, bot_id: "other", files: ["different.txt"] };
      expect(approvalEffectKey("run", name, changed)).not.toBe(key);
      const request = await resolveToolRequest(
        {
          deps: {},
          context: {},
          bot: { id: "sender" },
          tools: {
            connector: new Map(),
            approvedReplays: createApprovedEffectReplayQueue([
              { kind: name, request: original, idempotencyKey: key },
            ]),
          },
        } as never,
        name,
        changed,
        "execution",
      );
      expect(request).toMatchObject({ args: original, approvedEffectKey: key });
    },
  );
  it("delivers files as ordinary receiver attachments and preserves its delivery replay", async () => {
    const f = fixture();
    const deps = f.deps as unknown as Parameters<typeof messageBot>[0];
    const deliver = () =>
      messageBot(
        deps,
        run,
        { id: "sender", name: "Sender" },
        { bot_id: "receiver", message: "Review", deliveryKey: "effect", files: ["report.txt"] },
        { fileSource: f.source },
      );
    expect(await deliver()).toMatchObject({ ok: true });
    expect(f.messages).toHaveLength(2);
    expect(f.messages[1]?.blocks).toEqual([
      expect.objectContaining({ kind: "bot_message_received" }),
      expect.objectContaining({ kind: "file", artifactId: "artifact-0" }),
    ]);
    f.read.mockRejectedValue(new Error("source removed"));
    expect(await deliver()).toMatchObject({ ok: true, replayed: true });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.messages).toHaveLength(2);
    expect(f.rows).toHaveLength(1);
  });

  it("refuses retargeting a name-only replay without reading or copying files again", async () => {
    const f = fixture();
    const deps = f.deps as unknown as Parameters<typeof messageBot>[0];
    const deliver = () =>
      messageBot(
        deps,
        run,
        { id: "sender", name: "Sender" },
        {
          confirm_name: "Receiver",
          message: "Review",
          deliveryKey: "effect",
          files: ["report.txt"],
        },
        { fileSource: f.source },
      );
    expect(await deliver()).toMatchObject({ ok: true });
    f.target.botId = "different-bot";
    f.target.threadId = "different-thread";
    expect(await deliver()).toMatchObject({
      ok: false,
      error: expect.stringContaining("different recipient"),
    });
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.put).toHaveBeenCalledOnce();
    expect(f.messages).toHaveLength(2);
  });

  it("publishes group file blocks through the standard live event while retaining handoff", async () => {
    const f = fixture();
    expect(
      await handoffToGroupBot(
        f.deps as unknown as Parameters<typeof handoffToGroupBot>[0],
        run,
        "group",
        { bot_id: "receiver", message: "Review", deliveryKey: "effect", files: ["report.txt"] },
        { fileSource: f.source },
      ),
    ).toMatchObject({ ok: true });
    expect(f.events).toEqual([
      expect.objectContaining({
        type: "thread.message.created",
        payload: expect.objectContaining({
          messageId: "message-0",
          seq: 0,
          role: "bot",
          blocks: [
            expect.objectContaining({ kind: "handoff" }),
            expect.objectContaining({ kind: "file", artifactId: "artifact-0" }),
          ],
        }),
      }),
      expect.objectContaining({ type: "group.handoff" }),
    ]);
    expect(f.rows[0]).toMatchObject({ botId: "receiver", groupId: "group" });
  });

  it.each(["direct", "group"])(
    "keeps prepared objects after a lost %s COMMIT response, even when reads see no row",
    async (kind) => {
      const f = fixture();
      f.lostCommit();
      const normal = f.prisma.artifact.findFirst.getMockImplementation()!;
      f.prisma.artifact.findFirst.mockImplementation(async (args) =>
        args.where.storageKey ? null : normal(args),
      );
      const delivery =
        kind === "direct"
          ? messageBot(
              f.deps as unknown as Parameters<typeof messageBot>[0],
              run,
              { id: "sender", name: "Sender" },
              {
                bot_id: "receiver",
                message: "Review",
                deliveryKey: "effect",
                files: ["report.txt"],
              },
              { fileSource: f.source },
            )
          : handoffToGroupBot(
              f.deps as unknown as Parameters<typeof handoffToGroupBot>[0],
              run,
              "group",
              {
                bot_id: "receiver",
                message: "Review",
                deliveryKey: "effect",
                files: ["report.txt"],
              },
              { fileSource: f.source },
            );
      await expect(delivery).rejects.toThrow("lost commit response");
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.objects.size).toBe(1);
      expect(f.prisma.artifact.findFirst.mock.calls.some(([args]) => !!args.where.storageKey)).toBe(
        false,
      );
    },
  );
});
