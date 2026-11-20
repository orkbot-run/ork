// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createGroupRepos } from "./groups.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRepos } from "./repos.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}

async function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("group lock-order gate timed out")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Pause the real mutation immediately after its first SQL lock, without replacing SQL. */
function pauseAfterGroupLock(
  prisma: PrismaClient,
  locked: ReturnType<typeof gate>,
  resume: ReturnType<typeof gate>,
) {
  return new Proxy(prisma, {
    get(target, key) {
      if (key !== "$transaction") return Reflect.get(target, key);
      return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(
          async (tx) => {
            let first = true;
            return callback(
              new Proxy(tx, {
                get(transaction, operation) {
                  const value = Reflect.get(transaction, operation);
                  if (operation !== "$queryRaw") return value;
                  return async (...args: unknown[]) => {
                    const result = await Reflect.apply(value, transaction, args);
                    if (first) {
                      first = false;
                      locked.open();
                      await resume.ready;
                    }
                    return result;
                  };
                },
              }),
            );
          },
          { timeout: 20_000 },
        );
    },
  });
}

describePostgres("group locks alongside message and event writes (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let pool: Pool;
  let close: () => Promise<void>;
  let actor: Actor;
  let botIds: string[];
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!, { poolMax: 6 });
    prisma = db.prisma;
    system = asSystem(prisma);
    pool = db.pool;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    const owner = await runAsSystem("group lock-order fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        {
          signupsEnabled: undefined,
          signupAllowlist: undefined,
        },
      ),
    );
    actor = { ...owner, email: "group-lock@example.test", isDeploymentOwner: false };
    botIds = await runAsTenant(actor, async () => {
      const second = await createRepos(prisma).createBot(actor, {
        name: "Second",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      return [owner.botId, second.id];
    });
  });

  afterAll(async () => {
    try {
      if (actor) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.chatGroup.deleteMany({ where: { spaceId: actor.spaceId } });
        await system.organization.deleteMany({ where: { id: actor.spaceId } });
        await system.user.deleteMany({ where: { id: actor.userId } });
      }
    } finally {
      await close?.();
    }
  });

  async function createGroup() {
    return runAsTenant(actor, () =>
      createGroupRepos(prisma).createGroup(actor, {
        name: "Lock order",
        botIds,
      }),
    );
  }

  /** Hold the thread between the two real repository writes that update its counters. */
  function writer(threadId: string) {
    const messageWritten = gate();
    const append = gate();
    const eventWritten = gate();
    const commit = gate();
    let xactId = "";
    const done = runAsTenant(actor, () =>
      prisma.$transaction(
        async (tx) => {
          const message = await createThreadMessageInTransaction(tx, {
            threadId,
            role: "user",
            blocks: [{ kind: "text", text: "Concurrent message" }],
          });
          const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT pg_current_xact_id()::text AS id`;
          xactId = rows[0]!.id;
          messageWritten.open();
          await append.ready;
          const event = await appendEventInTransaction(tx, {
            spaceId: actor.spaceId,
            threadId,
            botId: botIds[0]!,
            type: "thread.message.created",
            payload: { messageId: message.id },
          });
          eventWritten.open();
          await commit.ready;
          return { message, event };
        },
        { timeout: 20_000 },
      ),
    );
    done.catch(() => undefined);
    return { messageWritten, append, eventWritten, commit, done, xactId: () => xactId };
  }

  it("a group mutation holds its lock while the writer appends its event", async () => {
    const group = await createGroup();
    const write = writer(group.threadId);
    const locked = gate();
    const resume = gate();
    let mutation: Promise<unknown> = Promise.resolve();
    try {
      await withinBudget(write.messageWritten.ready);
      mutation = runAsTenant(actor, () =>
        createGroupRepos(pauseAfterGroupLock(prisma, locked, resume)).updateGroup(actor, {
          groupId: group.id,
          name: "Renamed while writing",
        }),
      );
      mutation.catch(() => undefined);
      await withinBudget(locked.ready);
      write.append.open();
      // The mutation still holds the group row here. FOR UPDATE would block the
      // second thread update's foreign-key check until this gate is released.
      await withinBudget(write.eventWritten.ready);
      write.commit.open();
      const written = await write.done;
      resume.open();
      await mutation;
      expect(await system.chatGroup.findUniqueOrThrow({ where: { id: group.id } })).toMatchObject({
        name: "Renamed while writing",
      });
      expect(
        await system.thread.findUniqueOrThrow({ where: { id: group.threadId } }),
      ).toMatchObject({
        nextMessageSeq: 1,
        nextEventSeq: 1,
      });
      expect(await system.message.findUnique({ where: { id: written.message.id } })).not.toBeNull();
      expect(await system.event.findUnique({ where: { id: written.event.id } })).not.toBeNull();
    } finally {
      write.append.open();
      write.commit.open();
      resume.open();
      await Promise.allSettled([write.done, mutation]);
    }
  }, 30_000);

  it("remove waits on the writer before upgrading the group lock and cascades its writes", async () => {
    const group = await createGroup();
    const write = writer(group.threadId);
    let removal: Promise<unknown> = Promise.resolve();
    let probe: PoolClient | undefined;
    try {
      await withinBudget(write.messageWritten.ready);
      probe = await runAsSystem("group lock-order probe", () => pool.connect());
      removal = runAsTenant(actor, () => createGroupRepos(prisma).removeGroup(actor, group.id));
      removal.catch(() => undefined);
      const deadline = performance.now() + 5_000;
      for (;;) {
        const result = await probe.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1",
          [write.xactId()],
        );
        if (result.rows[0]!.waiting > 0) break;
        if (performance.now() >= deadline)
          throw new Error("removeGroup did not wait on the writer");
        await sleep(20);
      }
      // removeGroup is now queued on the held thread; its group lock must still
      // permit FK checks. An early FOR UPDATE upgrade fails this NOWAIT probe.
      const visible = await probe.query(
        "SELECT id FROM chat_groups WHERE id = $1 FOR KEY SHARE NOWAIT",
        [group.id],
      );
      expect(visible.rows).toHaveLength(1);
      expect(await system.chatGroupMember.count({ where: { groupId: group.id } })).toBe(2);
      write.append.open();
      await withinBudget(write.eventWritten.ready);
      write.commit.open();
      const written = await write.done;
      await removal;
      expect(await system.chatGroup.count({ where: { id: group.id } })).toBe(0);
      expect(await system.thread.count({ where: { id: group.threadId } })).toBe(0);
      expect(await system.chatGroupMember.count({ where: { groupId: group.id } })).toBe(0);
      expect(await system.message.count({ where: { id: written.message.id } })).toBe(0);
      expect(await system.event.count({ where: { id: written.event.id } })).toBe(0);
    } finally {
      write.append.open();
      write.commit.open();
      await Promise.allSettled([write.done, removal]);
      probe?.release();
    }
  }, 30_000);
});
