// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import { seededLogoAvatarColor } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createRepos,
  runAsSystem,
  runAsTenant,
} from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureFirstOrk, syncPrimaryOrk } from "./first-ork.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("personal Ork provisioning (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let other: PrismaClient;
  let close: () => Promise<void>;
  const owners: Array<{ actor: Actor; seed: string }> = [];
  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    const second = createDb(databaseUrl!);
    prisma = db.prisma;
    other = second.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await second.prisma.$disconnect();
      await db.pool.end();
      await second.pool.end();
    };
    await runAsSystem("create isolated personal Ork account fixtures", async () => {
      for (let index = 0; index < 4; index++) {
        const userId = randomUUID();
        const seed = randomUUID();
        await prisma.user.create({
          data: {
            id: userId,
            name: "Member",
            email: `${userId}@example.test`,
            emailVerified: true,
            orkAvatar: seed,
          },
        });
        const { spaceId } = await bootstrapUserSpace(
          prisma,
          { id: userId },
          { signupsEnabled: "true", signupAllowlist: undefined },
        );
        owners.push({
          actor: { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false },
          seed,
        });
      }
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    const system = asSystem(prisma);
    for (const { actor } of owners) {
      await system.organization.deleteMany({ where: { id: actor.spaceId } });
      await system.user.deleteMany({ where: { id: actor.userId } });
    }
    await close();
  });
  it("commits one primary across independent connections and restores its saved appearance", async () => {
    const { actor, seed } = owners[0]!;
    const [a, b] = await Promise.all(
      [prisma, other].map((db) =>
        runAsTenant(actor, () => ensureFirstOrk(db, createRepos(db), actor, true)),
      ),
    );
    expect(a?.id).toBeTruthy();
    expect(b).toMatchObject({
      id: a!.id,
      threadId: a!.threadId,
      avatarSeed: seed,
      color: seededLogoAvatarColor(seed),
      fleetManagement: true,
    });
    const system = asSystem(prisma);
    expect(await system.bot.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.thread.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.computer.count({ where: { userId: actor.userId } })).toBe(1);
    expect(await system.memoryDocument.count({ where: { botId: a!.id } })).toBe(1);
    const repeated = await runAsTenant(actor, () =>
      ensureFirstOrk(other, createRepos(other), actor, true),
    );
    expect(repeated).toMatchObject({ id: a!.id, avatarSeed: seed, color: a!.color });
  });
  it("gives another account its own Ork without sharing ids or generator seeds", async () => {
    const first = owners[0]!;
    const second = owners[1]!;
    const bot = await runAsTenant(second.actor, () =>
      ensureFirstOrk(prisma, createRepos(prisma), second.actor, true),
    );
    expect(bot).toMatchObject({
      name: "Chief",
      avatarSeed: second.seed,
      color: seededLogoAvatarColor(second.seed),
    });
    const original = await asSystem(prisma).bot.findFirstOrThrow({
      where: { userId: first.actor.userId },
    });
    expect(bot!.id).not.toBe(original.id);
    expect(bot!.avatarSeed).not.toBe(original.avatarSeed);
  });
  it("does not recreate an archived primary or add an Ork beside existing content", async () => {
    const first = owners[0]!;
    await asSystem(prisma).bot.updateMany({
      where: { userId: first.actor.userId },
      data: { archivedAt: new Date() },
    });
    expect(
      await runAsTenant(first.actor, () =>
        ensureFirstOrk(prisma, createRepos(prisma), first.actor, true),
      ),
    ).toBeNull();
    const { actor } = owners[2]!;
    const repos = createRepos(prisma);
    await runAsTenant(actor, () =>
      repos.createBot(actor, {
        name: "Existing",
        description: "",
        instructions: "",
        notifyOnFinish: true,
      }),
    );
    expect(await runAsTenant(actor, () => ensureFirstOrk(prisma, repos, actor, true))).toBeNull();
    expect(await asSystem(prisma).bot.count({ where: { userId: actor.userId } })).toBe(1);
  });
  it("adopts an original Chief once while retaining its identity and explicit image", async () => {
    const { actor, seed } = owners[3]!;
    const repos = createRepos(prisma);
    const image = "data:image/png;base64,aGVsbG8=";
    const chief = await runAsTenant(actor, () =>
      repos.createBot(actor, {
        name: "Chief",
        description: "",
        instructions: "",
        notifyOnFinish: true,
        fleetManagement: false,
        color: image,
      }),
    );
    await runAsTenant(actor, () => syncPrimaryOrk(prisma, actor, seed));
    let stored = await asSystem(prisma).bot.findUniqueOrThrow({ where: { id: chief.id } });
    expect(stored).toMatchObject({
      id: chief.id,
      name: "Chief",
      color: image,
      avatarSeed: seed,
      fleetManagement: true,
    });
    await asSystem(prisma).bot.update({
      where: { id: chief.id },
      data: { fleetManagement: false },
    });
    await runAsTenant(actor, () => syncPrimaryOrk(prisma, actor, seed));
    stored = await asSystem(prisma).bot.findUniqueOrThrow({ where: { id: chief.id } });
    expect(stored.fleetManagement).toBe(false);
    const reused = await runAsTenant(actor, () => ensureFirstOrk(prisma, repos, actor, true));
    expect(reused?.id).toBe(chief.id);
    expect(await asSystem(prisma).bot.count({ where: { userId: actor.userId } })).toBe(1);
  });
});
