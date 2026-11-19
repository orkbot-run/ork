// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("roster database notifications", () => {
  const envelopes: Array<{ topic: string; payload: string }> = [];
  let db: ReturnType<typeof createDb>;
  let actor: Actor;
  let listener: Client;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const identity = await runAsSystem("roster fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address: `roster-${randomUUID()}@orkbot.test` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "fixture@orkbot.test",
      isDeploymentOwner: false,
    };
    listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    await listener.query("LISTEN orkbot_events");
    listener.on("notification", ({ payload }) => {
      const envelope = JSON.parse(payload ?? "{}");
      if (
        envelope.topic === `roster:user:${actor.userId}` ||
        envelope.topic === `roster:space:${actor.spaceId}`
      )
        envelopes.push(envelope);
    });
  });

  afterAll(async () => {
    await listener?.end();
    if (actor) {
      const system = asSystem(db.prisma);
      const space = await system.space.findUnique({ where: { id: actor.spaceId } });
      if (space) await system.organization.deleteMany({ where: { id: space.organizationId } });
      await system.user.deleteMany({ where: { id: actor.userId } });
    }
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("emits a bodyless owner signal for a bot creation and a separate message activity signal", async () => {
    const bot = await runAsTenant(actor, () =>
      createRepos(db.prisma).createBot(actor, {
        name: "Initial name",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const userTopic = `roster:user:${actor.userId}`;
    await vi.waitFor(() =>
      expect(envelopes.shift()).toEqual({ topic: userTopic, payload: "roster" }),
    );
    await runAsTenant(actor, () =>
      db.prisma.thread.update({
        where: { id: bot.threadId },
        data: { nextMessageSeq: { increment: 1 } },
      }),
    );
    await vi.waitFor(() =>
      expect(envelopes.shift()).toEqual({ topic: userTopic, payload: "activity" }),
    );
    await runAsTenant(actor, () =>
      db.prisma.bot.update({ where: { id: bot.id }, data: { name: "Renamed" } }),
    );
    await vi.waitFor(() =>
      expect(envelopes.shift()).toEqual({ topic: userTopic, payload: "roster" }),
    );
    await asSystem(db.prisma).space.update({
      where: { id: actor.spaceId },
      data: { name: "Renamed Space" },
    });
    await vi.waitFor(() =>
      expect(envelopes).toEqual(
        expect.arrayContaining([
          { topic: `roster:space:${actor.spaceId}`, payload: "roster" },
          { topic: userTopic, payload: "roster" },
        ]),
      ),
    );
  });
});
