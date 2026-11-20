// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@orkbot/adapter-kit";
import { ACTIVE_RUN_STATUSES } from "@orkbot/core";
import type { Prisma, PrismaClient } from "@orkbot/db";
import { retryDatabaseOperation, runAsSystem, runAsSystemInTransaction } from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import { toComputerRef } from "./computer-support.js";
import { isSandboxGoneError } from "./sandbox-errors.js";

export const COMPUTER_BOOT_STALE_MS = 5 * 60_000;
const CHECK_INTERVAL_MS = 30_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 6;
const BATCH_SIZE = 25;

const trackedProviders = new Set([
  "boat",
  "boxd",
  "createos",
  "daytona",
  "e2b",
  "incus",
  "kubernetes",
  "novita",
  "railway",
]);

export function tracksNewComputers(kind: string): boolean {
  return trackedProviders.has(kind);
}

export async function recordUncommittedComputer(
  prisma: PrismaClient,
  owner: { id: string; spaceId: string; userId: string; homeKey: string },
  machine: Pick<ComputerRef, "kind" | "providerRef"> & { providerInstanceId?: string },
  connection = "",
) {
  const deadline = Date.now() + CHECK_INTERVAL_MS;
  await runAsSystem("record a provider allocation before completing computer startup", () =>
    retryDatabaseOperation(
      () =>
        prisma.computerOrphanCleanup.createMany({
          data: {
            kind: machine.kind,
            providerRef: machine.providerRef,
            providerInstanceId: machine.providerInstanceId,
            connection,
            computerId: owner.id,
            spaceId: owner.spaceId,
            userId: owner.userId,
            homeKey: owner.homeKey,
          },
          skipDuplicates: true,
        }),
      { deadline: () => deadline },
    ),
  );
}

export function orphanCleanupInProgress(tx: Prisma.TransactionClient, computerId: string) {
  return runAsSystemInTransaction(
    tx,
    "check for an in-flight deletion before computer startup",
    () =>
      tx.computerOrphanCleanup.findFirst({
        where: { computerId, leaseExpiresAt: { gt: new Date() } },
        select: { computerId: true },
      }),
  );
}

export function finishOrphanRegistration(
  tx: Prisma.TransactionClient,
  computerId: string,
  machine: Pick<ComputerRef, "kind" | "providerRef">,
) {
  return runAsSystemInTransaction(
    tx,
    "clear the cleanup record for an activated computer",
    async () => {
      await lockMachine(tx, machine);
      const deletion = await tx.computerOrphanCleanup.findFirst({
        where: {
          kind: machine.kind,
          providerRef: machine.providerRef,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { computerId: true },
      });
      if (deletion) return false;
      await tx.computerOrphanCleanup.deleteMany({
        where: { computerId, kind: machine.kind, providerRef: machine.providerRef },
      });
      return true;
    },
  );
}

function lockMachine(tx: Prisma.TransactionClient, machine: { kind: string; providerRef: string }) {
  const key = JSON.stringify(["computer orphan cleanup", machine.kind, machine.providerRef]);
  return tx.$queryRaw`
    SELECT true AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export function scheduleFailedComputerCleanup(prisma: PrismaClient, computerId: string) {
  return runAsSystem("make orphan cleanup due after failed computer startup", () =>
    prisma.computerOrphanCleanup.updateMany({
      where: { computerId, failedAt: null, leaseId: null },
      data: { nextAttemptAt: new Date() },
    }),
  );
}

type CleanupJob = Prisma.ComputerOrphanCleanupGetPayload<object>;

function jobIdentity(job: CleanupJob) {
  return {
    kind: job.kind,
    providerRef: job.providerRef,
    connection: job.connection,
    providerInstanceId: job.providerInstanceId,
  };
}

async function claimCleanup(prisma: PrismaClient, job: CleanupJob, now: Date) {
  return prisma.$transaction(async (tx) => {
    // Startup locks this same row before checking the deletion lease. A live startup wins,
    // or the deletion wins and blocks a new startup until the provider call has finished.
    await tx.$queryRaw`SELECT id FROM computers WHERE id = ${job.computerId} FOR UPDATE`;
    await lockMachine(tx, job);
    const identity = jobIdentity(job);
    const current = await tx.computerOrphanCleanup.findUnique({
      where: { kind_providerRef_connection_providerInstanceId: identity },
    });
    if (
      !current ||
      current.computerId !== job.computerId ||
      current.failedAt ||
      current.nextAttemptAt > now ||
      (current.leaseExpiresAt && current.leaseExpiresAt > now)
    ) {
      return null;
    }
    const computer = await tx.computer.findUnique({
      where: { id: job.computerId },
      select: { state: true, updatedAt: true, bootHeartbeatAt: true },
    });
    if (computer?.state === "booting") {
      const bootAt = computer.bootHeartbeatAt ?? computer.updatedAt;
      const liveBoot =
        now.getTime() - bootAt.getTime() < COMPUTER_BOOT_STALE_MS ||
        (await tx.run.findFirst({
          where: {
            status: { in: [...ACTIVE_RUN_STATUSES] },
            bot: { computerId: job.computerId },
            leaseExpiresAt: { gt: now },
          },
          select: { id: true },
        }));
      if (liveBoot) {
        await tx.computerOrphanCleanup.updateMany({
          where: { ...identity, leaseId: current.leaseId },
          data: { nextAttemptAt: new Date(now.getTime() + CHECK_INTERVAL_MS) },
        });
        return null;
      }
    }
    const linked = await tx.computer.findFirst({
      where: { kind: job.kind, providerRef: job.providerRef },
      select: { id: true },
    });
    if (linked) {
      await tx.computerOrphanCleanup.deleteMany({
        where: { ...identity, leaseId: current.leaseId },
      });
      return null;
    }
    const leaseId = randomUUID();
    const claimed = await tx.computerOrphanCleanup.updateMany({
      where: { ...identity, leaseId: current.leaseId },
      data: { leaseId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claimed.count !== 1) return null;
    if (computer?.state === "booting") {
      // Fence the abandoned boot before issuing a provider delete. A late activation cannot
      // attach this machine, even if that worker survived losing its heartbeat.
      await tx.computer.updateMany({
        where: { id: job.computerId, state: "booting", updatedAt: computer.updatedAt },
        data: { state: "error", bootHeartbeatAt: null },
      });
    }
    return { job: current, leaseId };
  });
}

async function cleanComputer(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  candidate: CleanupJob,
  now: () => Date,
) {
  const claimed = await claimCleanup(deps.prisma, candidate, now());
  if (!claimed) return;
  const { job, leaseId } = claimed;
  const computer = toComputerRef(job);
  const where = { ...jobIdentity(job), leaseId };
  const context: AdapterContext = {
    operationId: leaseId,
    traceId: leaseId,
    spaceId: job.spaceId,
    userId: job.userId,
    signal: AbortSignal.timeout(90_000),
  };
  const log = getLogger().child({ provider: job.kind, providerRef: job.providerRef });
  const timer = setInterval(() => {
    void deps.prisma.computerOrphanCleanup
      .updateMany({ where, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } })
      .catch((error) => log.warn("computer.orphan_cleanup_lease_failed", { error }));
  }, CHECK_INTERVAL_MS);
  timer.unref();
  try {
    if (deps.sandbox.destroyUncommitted) {
      await deps.sandbox.destroyUncommitted(
        computer,
        job.connection,
        context,
        job.providerInstanceId || undefined,
      );
    } else {
      await deps.sandbox.destroy(computer, context);
    }
  } catch (error) {
    if (!isSandboxGoneError(error)) {
      const attempts = job.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const failedAt = now();
      await deps.prisma.computerOrphanCleanup.updateMany({
        where,
        data: {
          attempts,
          failedAt: terminal ? failedAt : null,
          nextAttemptAt: new Date(failedAt.getTime() + CHECK_INTERVAL_MS * 2 ** (attempts - 1)),
          leaseId: null,
          leaseExpiresAt: null,
        },
      });
      if (terminal) log.error("computer.orphan_cleanup_exhausted", { attempts, error });
      else log.warn("computer.orphan_cleanup_retry", { attempts, error });
      return;
    }
  } finally {
    clearInterval(timer);
  }
  await deps.prisma.computerOrphanCleanup.deleteMany({ where });
}

export async function reconcileComputerOrphans(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  now?: Date,
) {
  const clock = () => now ?? new Date();
  await runAsSystem("reconcile uncommitted provider allocations across workspaces", async () => {
    const dueAt = clock();
    const due = await deps.prisma.computerOrphanCleanup.findMany({
      where: {
        failedAt: null,
        nextAttemptAt: { lte: dueAt },
        OR: [{ leaseId: null }, { leaseExpiresAt: { lte: dueAt } }],
      },
      orderBy: { nextAttemptAt: "asc" },
      take: BATCH_SIZE,
    });
    for (const job of due) {
      await cleanComputer(deps, job, clock).catch((error) =>
        getLogger().error("computer.orphan_cleanup_failed", {
          provider: job.kind,
          providerRef: job.providerRef,
          error,
        }),
      );
    }
  });
}
