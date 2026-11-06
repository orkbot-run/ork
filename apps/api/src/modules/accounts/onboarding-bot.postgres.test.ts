// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createOrganizationForUser,
  createRepos,
  createSpaceForMember,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureOnboardingBot } from "./onboarding-bot.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("onboarding bots across Spaces (PostgreSQL)", () => {
  const users: string[] = [];
  let db: ReturnType<typeof createDb>;
  let second: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;

  beforeAll(() => {
    db = createDb(databaseUrl!);
    second = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await system.organization.deleteMany({
        where: { members: { some: { userId: { in: users } } } },
      });
      await system.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await Promise.all([db.prisma.$disconnect(), second.prisma.$disconnect()]);
      await Promise.all([db.pool.end(), second.pool.end()]);
    }
  });

  async function signup() {
    const userId = randomUUID();
    const seed = randomUUID();
    const email = `${userId}@example.test`;
    users.push(userId);
    await system.user.create({
      data: { id: userId, name: "Member", email, emailVerified: true, orkAvatar: seed },
    });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id: userId },
      { signupsEnabled: "true", signupAllowlist: undefined },
    );
    const actor: Actor = { userId, spaceId, email, isDeploymentOwner: false };
    return { actor, seed };
  }

  async function sibling(actor: Actor): Promise<Actor> {
    const space = await runAsSystem("create an isolated onboarding Space fixture", () =>
      createSpaceForMember(prisma, {
        currentSpaceId: actor.spaceId,
        userId: actor.userId,
        name: "Clients",
      }),
    );
    return { ...actor, spaceId: space.id };
  }

  function ensure(actor: Actor, ready = true, client = prisma) {
    return runAsTenant(actor, () => ensureOnboardingBot(client, createRepos(client), actor, ready));
  }

  it("keeps the account's personal Ork unique on repeated visits", async () => {
    const { actor, seed } = await signup();
    const first = await ensure(actor);
    expect(first).toMatchObject({ name: "Chief", avatarSeed: seed });
    expect(await ensure(actor, true, second.prisma)).toMatchObject({
      id: first!.id,
      threadId: first!.threadId,
      avatarSeed: seed,
    });
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.thread.count({ where: { userId: actor.userId } })).toBe(1);
  });

  it("does not fall back to an ordinary bot after the personal Ork is archived", async () => {
    const { actor, seed } = await signup();
    const primary = await ensure(actor);
    await system.bot.update({
      where: { id: primary!.id },
      data: { archivedAt: new Date() },
    });
    expect(await ensure(actor)).toBeNull();
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.bot.findUniqueOrThrow({ where: { id: primary!.id } })).toMatchObject({
      avatarSeed: seed,
      archivedAt: expect.any(Date),
    });
  });

  it("does not add a personal or ordinary bot beside prior account content", async () => {
    const { actor } = await signup();
    const existing = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name: "Existing assistant",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    expect(await ensure(actor)).toBeNull();
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.bot.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      name: "Existing assistant",
      avatarSeed: null,
    });
  });

  it("creates ordinary bots in a sibling Space and another organization's default Space", async () => {
    const { actor, seed } = await signup();
    const primary = await ensure(actor);
    const clients = await sibling(actor);
    const work = await createOrganizationForUser(system, { userId: actor.userId, name: "Work" });
    const workActor = { ...actor, spaceId: work.defaultSpaceId };
    for (const target of [clients, workActor]) {
      const bot = await ensure(target);
      expect(bot).toMatchObject({ name: "Chief", avatarSeed: null });
      expect(bot!.id).not.toBe(primary!.id);
      expect(await system.bot.findUniqueOrThrow({ where: { id: bot!.id } })).toMatchObject({
        userId: actor.userId,
        spaceId: target.spaceId,
        avatarSeed: null,
      });
    }
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(3);
    expect(await system.bot.count({ where: { userId: actor.userId, avatarSeed: seed } })).toBe(1);
  });

  it("reuses an existing renamed bot in an ordinary Space", async () => {
    const { actor } = await signup();
    const clients = await sibling(actor);
    const existing = await runAsTenant(clients, () =>
      createRepos(prisma).createBot(clients, {
        name: "My chosen name",
        description: "Existing purpose",
        instructions: "Keep this configuration.",
        notifyOnFinish: true,
        spawnKey: "onboarding:first",
      }),
    );
    expect(await ensure(clients)).toMatchObject({
      id: existing.id,
      name: "My chosen name",
      description: "Existing purpose",
      instructions: "Keep this configuration.",
      avatarSeed: null,
    });
    expect(await system.bot.count({ where: { spaceId: clients.spaceId } })).toBe(1);
  });

  it("converges on one ordinary bot across independent database connections", async () => {
    const { actor } = await signup();
    const clients = await sibling(actor);
    const [first, concurrent] = await Promise.all([
      ensure(clients),
      ensure(clients, true, second.prisma),
    ]);
    expect(first).toMatchObject({ name: "Chief", avatarSeed: null });
    expect(concurrent).toMatchObject({ id: first!.id, threadId: first!.threadId });
    expect(await system.bot.count({ where: { spaceId: clients.spaceId } })).toBe(1);
    expect(await system.thread.count({ where: { spaceId: clients.spaceId } })).toBe(1);
    expect(await system.memoryDocument.count({ where: { botId: first!.id } })).toBe(1);
  });

  it("creates nothing before setup is ready in either kind of Space", async () => {
    const { actor } = await signup();
    const clients = await sibling(actor);
    expect(await ensure(actor, false)).toBeNull();
    expect(await ensure(clients, false)).toBeNull();
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(0);
    expect(await system.thread.count({ where: { userId: actor.userId } })).toBe(0);
  });
});
