// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("identity text sanitization (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: (() => Promise<void>) | undefined;
  let owner: { userId: string; spaceId: string; botId: string } | undefined;
  const provider = "sendblue";
  const address = "+15550003230";

  afterAll(async () => {
    if (owner) {
      const system = asSystem(prisma, "identity fixture cleanup");
      await system.messagingIdentity.deleteMany({ where: { provider, address } });
      await system.organization.deleteMany({ where: { id: owner.spaceId } });
      await system.user.deleteMany({ where: { id: owner.userId } });
    }
    await close?.();
  });

  it("cleans human names at rest and on legacy reads, preserving message and JSON text", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    owner = await runAsSystem("identity fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider, address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const system = asSystem(prisma);
    const name = "Alice\u202e שלום 👩‍💻";
    const cleanName = "Alice שלום 👩‍💻";
    await system.user.update({ where: { id: owner.userId }, data: { name } });
    await system.bot.update({ where: { id: owner.botId }, data: { name: { set: name } } });
    const group = await system.chatGroup.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        name,
      },
    });
    const stored = await system.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM "user" WHERE id = ${owner.userId}
      UNION ALL SELECT name FROM bots WHERE id = ${owner.botId}
      UNION ALL SELECT name FROM chat_groups WHERE id = ${group.id}
    `;
    expect(stored).toEqual([{ name: cleanName }, { name: cleanName }, { name: cleanName }]);

    const thread = await system.thread.findUniqueOrThrow({ where: { botId: owner.botId } });
    const blocks = [{ kind: "text", text: "שלום\u202e body", metadata: { name } }];
    const message = await system.message.create({
      data: {
        threadId: thread.id,
        seq: 100,
        role: "user",
        blocks,
      },
    });
    expect((await system.message.findUniqueOrThrow({ where: { id: message.id } })).blocks).toEqual(
      blocks,
    );

    await system.$executeRaw`UPDATE bots SET name = ${name} WHERE id = ${owner.botId}`;
    expect((await system.bot.findUniqueOrThrow({ where: { id: owner.botId } })).name).toBe(
      cleanName,
    );
    expect(
      await system.$queryRaw<
        Array<{ name: string }>
      >`SELECT name FROM bots WHERE id = ${owner.botId}`,
    ).toEqual([{ name }]);
  });
});
