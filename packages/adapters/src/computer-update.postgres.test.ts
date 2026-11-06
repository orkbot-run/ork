// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@orkbot/db";
import { asSystem, createDb } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reconcileComputerUpdates } from "./computer-update.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("interrupted maintenance expiry (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const userId = randomUUID();
  const jobs = { enqueue: vi.fn(async () => {}) };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = asSystem(db.prisma);
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Test organization",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Test space" } });
    await prisma.user.create({
      data: { id: userId, name: "Test user", email: `${userId}@example.test` },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await prisma.computer.deleteMany({ where: { spaceId } });
    await prisma.space.delete({ where: { id: spaceId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function interrupted() {
    const id = randomUUID();
    const updateId = randomUUID();
    await prisma.computer.create({
      data: {
        id,
        spaceId,
        userId,
        scope: "team",
        scopeKey: id,
        homeKey: id,
        kind: "fake",
        state: "booting",
        providerRef: "provider-test",
        maintenanceId: updateId,
      },
    });
    const update = await prisma.computerUpdate.create({
      data: {
        id: updateId,
        computerId: id,
        botId: "bot-test",
        status: "interrupted",
        updatedAt: new Date(Date.now() - 61 * 60_000),
      },
    });
    return update;
  }

  function deps(client: unknown = prisma) {
    return { prisma: client, jobs } as unknown as Parameters<typeof reconcileComputerUpdates>[0];
  }

  it("quarantines and releases atomically, advancing the provisioning fence", async () => {
    const update = await interrupted();
    const before = await prisma.computer.findUniqueOrThrow({ where: { id: update.computerId } });
    await reconcileComputerUpdates(deps());
    const computer = await prisma.computer.findUniqueOrThrow({ where: { id: update.computerId } });
    expect(computer).toMatchObject({
      maintenanceId: null,
      state: "quarantined",
      providerRef: "provider-test",
    });
    expect(computer.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(
      await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
    ).toMatchObject({ status: "failed" });
    // The abandoned worker still holds the old stamp and reservation.
    const activated = await prisma.computer.updateMany({
      where: {
        id: computer.id,
        state: "booting",
        updatedAt: before.updatedAt,
        maintenanceId: update.id,
      },
      data: { state: "running" },
    });
    expect(activated.count).toBe(0);
  });

  it("rolls the status change back if releasing the computer fails", async () => {
    const update = await interrupted();
    const client = {
      computerUpdate: prisma.computerUpdate,
      $transaction: (async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        prisma.$transaction(async (tx) => {
          let writes = 0;
          const failing = {
            computerUpdate: tx.computerUpdate,
            computer: {
              updateMany: async (args: Prisma.ComputerUpdateManyArgs) => {
                if (++writes === 2) throw new Error("release failed");
                return tx.computer.updateMany(args);
              },
            },
          } as unknown as Prisma.TransactionClient;
          return run(failing);
        })) as PrismaClient["$transaction"],
    };
    await expect(reconcileComputerUpdates(deps(client))).rejects.toThrow("release failed");
    expect(
      await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
    ).toMatchObject({ status: "interrupted" });
    expect(
      await prisma.computer.findUniqueOrThrow({ where: { id: update.computerId } }),
    ).toMatchObject({ maintenanceId: update.id, state: "booting" });
  });

  it("lets concurrent reconcilers settle an abandoned reservation only once", async () => {
    const update = await interrupted();
    await Promise.all([reconcileComputerUpdates(deps()), reconcileComputerUpdates(deps())]);
    expect(
      await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
    ).toMatchObject({ status: "failed" });
    expect(
      await prisma.computer.findUniqueOrThrow({ where: { id: update.computerId } }),
    ).toMatchObject({ state: "quarantined", maintenanceId: null, providerRef: "provider-test" });
  });

  it.each(["completed", "failed"])(
    "preserves a worker's %s result committed after the stale read",
    async (status) => {
      const update = await interrupted();
      const client = {
        $transaction: prisma.$transaction,
        computerUpdate: {
          findMany: async (args: Prisma.ComputerUpdateFindManyArgs) => {
            const rows = await prisma.computerUpdate.findMany(args);
            if (rows.some((row) => row.id === update.id)) {
              await prisma.$transaction(async (tx) => {
                await tx.computerUpdate.update({ where: { id: update.id }, data: { status } });
                await tx.computer.update({
                  where: { id: update.computerId },
                  data: { state: "running", maintenanceId: null },
                });
              });
            }
            return rows;
          },
        },
      };
      await reconcileComputerUpdates(deps(client));
      expect(
        await prisma.computerUpdate.findUniqueOrThrow({ where: { id: update.id } }),
      ).toMatchObject({ status });
      expect(
        await prisma.computer.findUniqueOrThrow({ where: { id: update.computerId } }),
      ).toMatchObject({ state: "running", maintenanceId: null });
    },
  );
});
