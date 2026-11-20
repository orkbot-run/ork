// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Actor } from "@orkbot/contracts";
import { MessageBlock } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  declareRunReaderVersion,
  provisionMessagingIdentity,
  RunHistoryWriteError,
} from "@orkbot/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSpaceArtifact } from "#modules/content/artifacts";
import { LocalArtifactStore } from "../../../../../packages/adapters/src/artifacts.js";
import { DesktopSandboxProvider } from "../../../../../packages/adapters/src/desktop-sandbox.js";
import { postToGroup } from "../../../../../packages/adapters/src/group-post.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("group-post publication (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let run: { id: string; spaceId: string; userId: string; botId: string; threadId: string };
  let group: { id: string; name: string };
  let targetThread: { id: string };
  let deps: Parameters<typeof postToGroup>[0];
  const roots: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `group-post-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const { spaceId, userId, botId, threadId } = identity;
    await prisma.run.updateMany({ where: { spaceId }, data: { status: "cancelled" } });
    const task = await prisma.task.create({
      data: { spaceId, userId, botId, threadId, prompt: "Publish report", status: "running" },
    });
    const source = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "routine",
        leaseOwner: "worker",
        leaseFence: 1,
      },
    });
    run = { id: source.id, spaceId, userId, botId, threadId };
    group = await makeGroup("Team reports");
    targetThread = await prisma.thread.findFirstOrThrow({ where: { groupId: group.id } });
    deps = {
      prisma,
      events: createThreadEvents(prisma),
      runLease: { runId: run.id, owner: "worker", fence: 1 },
    };
  });

  async function makeGroup(name: string, member = true) {
    const row = await prisma.chatGroup.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        name,
        ...(member ? { members: { create: { botId: run.botId } } } : {}),
      },
    });
    await prisma.thread.create({
      data: { spaceId: run.spaceId, userId: run.userId, groupId: row.id },
    });
    return row;
  }
  const publish = (groupName = group.name, deliveryKey = "report") =>
    postToGroup(deps, run, { group: groupName, message: "Report", deliveryKey });

  it("publishes a bot-authored ordinary message by normalized name and admits no new task or run", async () => {
    const runs = await prisma.run.count({ where: { spaceId: run.spaceId } });
    const tasks = await prisma.task.count({ where: { spaceId: run.spaceId } });
    const notify = vi.spyOn(deps.events, "notify");
    const result = await publish("  TEAM   reports  ");
    expect(result).toMatchObject({ ok: true, groupId: group.id, threadId: targetThread.id });
    const message = await prisma.message.findFirstOrThrow({ where: { threadId: targetThread.id } });
    expect(message).toMatchObject({
      role: "bot",
      botId: run.botId,
      runId: null,
      blocks: [{ kind: "text", text: "Report" }],
    });
    expect(await prisma.event.findFirst({ where: { threadId: targetThread.id } })).toMatchObject({
      type: "thread.message.created",
      botId: run.botId,
      runId: null,
    });
    expect(await prisma.run.findUnique({ where: { id: run.id } })).toMatchObject({
      firstResponseAt: null,
    });
    expect(await prisma.thread.findUnique({ where: { id: targetThread.id } })).toMatchObject({
      unread: true,
    });
    expect(notify).toHaveBeenCalledWith(targetThread.id, expect.any(Number));
    expect(await prisma.run.count({ where: { spaceId: run.spaceId } })).toBe(runs);
    expect(await prisma.task.count({ where: { spaceId: run.spaceId } })).toBe(tasks);
  });

  it("rejects current group, nonmembership, archived destinations and ambiguous names", async () => {
    expect(
      await postToGroup(
        deps,
        { ...run, threadId: targetThread.id },
        { group: group.id, message: "No", deliveryKey: "current" },
      ),
    ).toHaveProperty("error");
    const other = await makeGroup("Private", false);
    expect(await publish(other.id)).toHaveProperty("error");
    expect(await publish(other.name)).toHaveProperty("error");
    await makeGroup("  TEAM REPORTS  ");
    expect(await publish()).toMatchObject({ error: expect.stringContaining("ambiguous") });
    expect(await publish(group.id)).toHaveProperty("ok", true);
    await prisma.chatGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
    expect(await publish(group.id, "archive")).toHaveProperty("error");
  });

  it("pins retry to its first destination after rename/reassignment and scopes keys by source run", async () => {
    const first = await publish();
    await prisma.chatGroup.update({ where: { id: group.id }, data: { name: "Renamed" } });
    const replacement = await makeGroup("Team reports");
    expect(await publish("Team reports")).toEqual({ ...first, groupName: "Renamed" });
    expect(await prisma.message.count({ where: { thread: { groupId: replacement.id } } })).toBe(0);
    const source = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    const next = await prisma.run.create({ data: { ...source, id: randomUUID() } });
    const second = await postToGroup(
      { ...deps, runLease: { runId: next.id, owner: "worker", fence: 1 } },
      { ...run, id: next.id },
      { group: group.id, message: "Second", deliveryKey: "report" },
    );
    expect(second).toHaveProperty("ok", true);
    expect(await prisma.message.count({ where: { threadId: targetThread.id } })).toBe(2);
    await prisma.chatGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
    expect(await publish("Team reports")).toHaveProperty("error");
    expect(await prisma.message.count({ where: { thread: { groupId: replacement.id } } })).toBe(0);
  });

  it("serializes concurrent replays into one message and event", async () => {
    const results = await Promise.all([publish(group.id), publish(group.id)]);
    expect(results[0]).toEqual(results[1]);
    expect(await prisma.message.count({ where: { threadId: targetThread.id } })).toBe(1);
    expect(await prisma.event.count({ where: { threadId: targetThread.id } })).toBe(1);
  });

  it("rejects cross-space destination, removed membership and stale source lease", async () => {
    const peer = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `group-post-peer-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const foreign = await prisma.chatGroup.create({
      data: { spaceId: peer.spaceId, userId: peer.userId, name: "Foreign" },
    });
    expect(await publish(foreign.id)).toHaveProperty("error");
    await replaceLease();
    await expect(publish(group.id)).rejects.toBeInstanceOf(RunHistoryWriteError);
    await prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: run.botId } });
    expect(await publish(group.id)).toHaveProperty("error");
    expect(await prisma.message.count({ where: { threadId: targetThread.id } })).toBe(0);
  });

  async function replaceLease() {
    await prisma.$transaction(async (tx) => {
      await declareRunReaderVersion(tx);
      await tx.run.update({
        where: { id: run.id },
        data: { leaseOwner: "replacement", leaseFence: 2 },
      });
    });
  }

  async function filesFixture() {
    const root = await mkdtemp(path.join(tmpdir(), "ork-group-post-"));
    roots.push(root);
    const sandbox = new DesktopSandboxProvider({ root });
    const artifacts = new LocalArtifactStore(root);
    const bot = await prisma.bot.findUniqueOrThrow({ where: { id: run.botId } });
    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: bot.computerId! } });
    const context = {
      ...run,
      runId: run.id,
      operationId: run.id,
      traceId: run.id,
      signal: new AbortController().signal,
    };
    const ref = await sandbox.provision({ botId: computer.homeKey, homePath: "unused" }, context);
    await prisma.computer.update({
      where: { id: computer.id },
      data: { kind: "desktop", providerRef: ref.providerRef, scope: "team" },
    });
    const filePath = `bots/${run.botId}/report.txt`;
    await sandbox.writeFile(ref, {
      path: filePath,
      content: new TextEncoder().encode("original report"),
    });
    const fileSource = {
      computerId: computer.id,
      mode: "team" as const,
      computer: async () => ref,
      context,
    };
    return { sandbox, artifacts, filePath, fileSource, ref, deps: { ...deps, sandbox, artifacts } };
  }

  it("materializes shared-computer files as group-visible attachments and keeps retry snapshot", async () => {
    const f = await filesFixture();
    const post = () =>
      postToGroup(
        f.deps,
        run,
        { group: group.id, message: "With attachment", deliveryKey: "files", files: [f.filePath] },
        { fileSource: f.fileSource },
      );
    const result = await post();
    expect(result).toHaveProperty("ok", true);
    const message = await prisma.message.findFirstOrThrow({ where: { threadId: targetThread.id } });
    const blocks = MessageBlock.array().parse(message.blocks);
    const file = blocks.find((block) => block.kind === "file");
    expect(file).toBeDefined();
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { groupId: group.id } });
    expect(artifact).toMatchObject({ botId: run.botId, runId: run.id });
    const actor: Actor = {
      userId: run.userId,
      spaceId: run.spaceId,
      email: "fixture@example.test",
      isDeploymentOwner: false,
    };
    const downloaded = await getSpaceArtifact({ prisma, artifacts: f.artifacts }, actor, {
      artifactId: artifact.id,
      groupId: group.id,
      contextBotId: run.botId,
    });
    expect(Buffer.from(downloaded.contentBase64, "base64").toString()).toBe("original report");
    await f.sandbox.writeFile(f.ref, {
      path: f.filePath,
      content: new TextEncoder().encode("modified"),
    });
    expect(await post()).toEqual(result);
    expect(await prisma.artifact.count({ where: { groupId: group.id } })).toBe(1);
    expect(await prisma.message.count({ where: { threadId: targetThread.id } })).toBe(1);
    expect(await prisma.run.count({ where: { threadId: targetThread.id } })).toBe(0);
  });

  it("rechecks source lease after file preparation and rolls back attachment metadata", async () => {
    const f = await filesFixture();
    const read = f.sandbox.readTransferFile.bind(f.sandbox);
    vi.spyOn(f.sandbox, "readTransferFile").mockImplementation(async (...args) => {
      const bytes = await read(...args);
      await replaceLease();
      return bytes;
    });
    await expect(
      postToGroup(
        f.deps,
        run,
        { group: group.id, message: "Stale", deliveryKey: "stale", files: [f.filePath] },
        { fileSource: f.fileSource },
      ),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    expect(await prisma.artifact.count({ where: { groupId: group.id } })).toBe(0);
    expect(await prisma.message.count({ where: { threadId: targetThread.id } })).toBe(0);
  });
});
