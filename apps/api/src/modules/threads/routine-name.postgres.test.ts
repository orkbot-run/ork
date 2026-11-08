// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { FakeSandboxProvider } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createGroupRepos,
  createRepos,
  provisionMessagingIdentity,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRoutineTestRun } from "#modules/routines/routines";
import { resolveThreadTarget, threadSnapshot } from "./thread-target.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("routine name projection (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  const identities: Array<{ userId: string; spaceId: string }> = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
  });
  async function identity() {
    const identity = await provisionMessagingIdentity(
      system,
      { provider: "test", address: `routine-label-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    identities.push(identity);
    return identity;
  }
  beforeEach(async () => {
    const own = await identity();
    actor = {
      userId: own.userId,
      spaceId: own.spaceId,
      email: "fixture@example.test",
      isDeploymentOwner: false,
    };
    botId = own.botId;
    threadId = own.threadId;
  });
  afterEach(async () => {
    for (const identity of identities.splice(0)) {
      await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  function routine(
    data: Partial<{
      name: string;
      threadId: string | null;
      botId: string;
      userId: string;
      spaceId: string;
    }> = {},
  ) {
    return system.routine.create({
      data: {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        threadId,
        name: "Morning report",
        prompt: "Prepare the report",
        crons: ["0 9 * * *"],
        ...data,
      },
    });
  }
  async function run(
    routineId: string,
    data: { botId?: string; threadId?: string; clientNonce?: string } = {},
  ) {
    const { clientNonce, ...target } = data;
    const scope = { userId: actor.userId, spaceId: actor.spaceId, botId, threadId, ...target };
    const task = await system.task.create({
      data: { ...scope, prompt: "Fixture", status: "running" },
    });
    return system.run.create({
      data: {
        ...scope,
        taskId: task.id,
        status: "running",
        trigger: "routine",
        routineId,
        clientNonce,
      },
    });
  }
  async function snapshot(target: { botId: string } | { groupId: string }, bypass = false) {
    const resolved = await runAsTenant(actor, () => resolveThreadTarget(db.prisma, actor, target));
    return bypass
      ? threadSnapshot({ prisma: system, sandbox: new FakeSandboxProvider() }, resolved)
      : runAsTenant(actor, () =>
          threadSnapshot({ prisma: db.prisma, sandbox: new FakeSandboxProvider() }, resolved),
        );
  }
  async function groups() {
    const peer = await createRepos(system).createBot(actor, {
      name: "Peer",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const repos = createGroupRepos(system);
    return {
      peer,
      first: await repos.createGroup(actor, { name: "First", botIds: [botId, peer.id] }),
      second: await repos.createGroup(actor, { name: "Second", botIds: [botId, peer.id] }),
    };
  }
  it("hydrates an owned active name, clamps legacy length and falls back after deletion", async () => {
    const source = await routine();
    const active = await run(source.id);
    expect((await snapshot({ botId })).run).toMatchObject({
      id: active.id,
      routineName: source.name,
    });
    await system.routine.update({ where: { id: source.id }, data: { name: "A".repeat(250) } });
    expect((await snapshot({ botId })).activeRuns?.[0]?.routineName).toBe("A".repeat(200));
    await system.routine.delete({ where: { id: source.id } });
    expect((await snapshot({ botId })).activeRuns?.[0]).toMatchObject({
      routineId: null,
      routineName: null,
    });
  });
  it("keeps each group label with its run and hides a routine moved to another thread", async () => {
    const { first, second, peer } = await groups();
    const firstTarget = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { groupId: first.id }),
    );
    const secondTarget = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { groupId: second.id }),
    );
    const a = await routine({ threadId: firstTarget.threadId });
    const b = await routine({
      botId: peer.id,
      threadId: firstTarget.threadId,
      name: "Evening report",
    });
    const arun = await run(a.id, { threadId: firstTarget.threadId });
    const brun = await run(b.id, { botId: peer.id, threadId: firstTarget.threadId });
    const before = (await snapshot({ groupId: first.id })).activeRuns;
    expect(before?.find((run) => run.id === arun.id)?.routineName).toBe("Morning report");
    expect(before?.find((run) => run.id === brun.id)?.routineName).toBe("Evening report");
    await system.routine.update({
      where: { id: a.id },
      data: { threadId: secondTarget.threadId, name: "Moved report" },
    });
    expect(
      (await snapshot({ groupId: first.id })).activeRuns?.find((run) => run.id === arun.id)
        ?.routineName,
    ).toBeNull();
  });
  it("allows legacy null routing only in the actual bot DM", async () => {
    const { first } = await groups();
    const group = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { groupId: first.id }),
    );
    const source = await routine({ threadId: null });
    const direct = await run(source.id);
    const grouped = await run(source.id, { threadId: group.threadId });
    expect(
      (await snapshot({ botId })).activeRuns?.find((run) => run.id === direct.id)?.routineName,
    ).toBe(source.name);
    expect(
      (await snapshot({ groupId: first.id })).activeRuns?.find((run) => run.id === grouped.id)
        ?.routineName,
    ).toBeNull();
  });
  it("rejects foreign owner/Space and bot relations even under a system read", async () => {
    const foreign = await identity();
    const source = await routine({
      userId: foreign.userId,
      spaceId: foreign.spaceId,
      botId: foreign.botId,
      threadId: foreign.threadId,
      name: "Private foreign name",
    });
    const corrupted = await run(source.id);
    expect(
      (await snapshot({ botId }, true)).activeRuns?.find((run) => run.id === corrupted.id)
        ?.routineName,
    ).toBeNull();
    const { peer } = await groups();
    const target = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { botId: peer.id }),
    );
    const otherBot = await routine({
      botId: peer.id,
      threadId: target.threadId,
      name: "Different bot name",
    });
    const wrongBot = await run(otherBot.id);
    expect(
      (await snapshot({ botId }, true)).activeRuns?.find((run) => run.id === wrongBot.id)
        ?.routineName,
    ).toBeNull();
  });
  it("labels a group routine tested in DM only through the canonical manual producer", async () => {
    const { first, second } = await groups();
    const group = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { groupId: first.id }),
    );
    const other = await runAsTenant(actor, () =>
      resolveThreadTarget(db.prisma, actor, { groupId: second.id }),
    );
    const source = await routine({ threadId: group.threadId });
    const manual = await runAsTenant(actor, () =>
      db.prisma.$transaction((tx) =>
        createRoutineTestRun(
          tx,
          actor,
          { routine: source, botId, threadId },
          source.prompt,
          undefined,
        ),
      ),
    );
    const stored = await system.run.findUniqueOrThrow({ where: { id: manual.id } });
    expect(stored.clientNonce).toMatch(new RegExp(`^routine-run:${actor.userId}:.+`));
    expect(
      (await snapshot({ botId })).activeRuns?.find((run) => run.id === manual.id)?.routineName,
    ).toBe(source.name);
    for (const clientNonce of [
      undefined,
      "routine-test:legacy",
      "routine:timer",
      "watch:change",
      "routine-run:foreign:key",
    ]) {
      const ordinary = await run(source.id, { clientNonce });
      expect(
        (await snapshot({ botId })).activeRuns?.find((run) => run.id === ordinary.id)?.routineName,
      ).toBeNull();
    }
    const movedGroup = await run(source.id, {
      threadId: other.threadId,
      clientNonce: `routine-run:${actor.userId}:cannot-adopt-group`,
    });
    expect(
      (await snapshot({ groupId: second.id })).activeRuns?.find((run) => run.id === movedGroup.id)
        ?.routineName,
    ).toBeNull();
  });
});
