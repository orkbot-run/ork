// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import { verifiedNativeSessionIdentity } from "@orkbot/auth";
import type { ServerUpdatesStatus } from "@orkbot/contracts";
import type { PrismaClient, ServerUpdateRequest } from "@orkbot/db";
import { runAsSystem, ServerUpdateConflict, serverUpdateStore } from "@orkbot/db";
import { ORPCError } from "@orpc/server";

export interface ServerUpdateActor {
  userId: string;
  sessionId?: string;
}
export const unavailableServerUpdates = (): ServerUpdatesStatus => ({
  available: false,
  mode: "manual",
  channel: null,
  currentRevision: null,
  candidate: null,
  lastCheckedAt: null,
  policyRevision: 0,
  lastRequest: null,
  error: null,
});

export function createServerUpdates(options: {
  prisma: PrismaClient;
  adapter: ServerUpdateAdapter;
  installationId: string;
  delegatedAccountKey: string;
  issuer: string;
  currentRevision: string | null;
}) {
  if (
    !/^[a-f0-9]{64}$/.test(options.delegatedAccountKey) ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(options.installationId)
  )
    throw new Error("Invalid update control binding");
  const { prisma, adapter, delegatedAccountKey } = options;
  const store = serverUpdateStore(prisma, { ...options, channel: adapter.channel });
  const pending = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const track = (work: Promise<unknown>) => {
    pending.add(work);
    void work.catch(() => {}).finally(() => pending.delete(work));
  };
  const system = <T>(action: () => Promise<T>) =>
    runAsSystem("manage explicitly delegated server updates", action);
  async function owner() {
    const deployment = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { nativeAccountsOwnerKey: true },
    });
    if (deployment?.nativeAccountsOwnerKey !== delegatedAccountKey) return null;
    const linked = await prisma.account.findFirst({
      where: {
        providerId: "oidc",
        accountId: delegatedAccountKey,
        user: { members: { some: { spaceMemberships: { some: {} } } } },
      },
      select: { userId: true },
    });
    return linked?.userId ?? null;
  }
  async function authorize(actor: ServerUpdateActor) {
    if (
      !actor.sessionId ||
      (await owner()) !== actor.userId ||
      (await verifiedNativeSessionIdentity(
        prisma,
        actor.sessionId,
        actor.userId,
        options.issuer,
      )) !== delegatedAccountKey
    )
      throw new ORPCError("FORBIDDEN");
  }
  async function snapshot(): Promise<ServerUpdatesStatus> {
    await store.recover();
    const [control, last] = await Promise.all([store.control(), store.latest()]);
    const currentOwnerId = await owner();
    const candidate =
      options.currentRevision &&
      control.candidateBaseRevision === options.currentRevision &&
      control.candidateRevision &&
      control.candidateVersion &&
      control.candidateRevision !== options.currentRevision
        ? { revision: control.candidateRevision, version: control.candidateVersion }
        : null;
    const state = last?.state === "queued" ? "submitting" : last?.state;
    return {
      available: true,
      mode:
        control.automatic &&
        control.consentedAccountKey === delegatedAccountKey &&
        control.consentedUserId === currentOwnerId &&
        currentOwnerId
          ? "automatic"
          : "manual",
      channel: adapter.channel,
      currentRevision: options.currentRevision,
      candidate,
      lastCheckedAt: control.lastCheckedAt?.toISOString() ?? null,
      policyRevision: control.policyRevision,
      lastRequest: last
        ? {
            id: last.idempotencyKey,
            revision: last.revision,
            state: state as NonNullable<ServerUpdatesStatus["lastRequest"]>["state"],
            requestedAt: last.createdAt.toISOString(),
          }
        : null,
      error: control.checkFailed
        ? "check-failed"
        : state === "unknown" || state === "failed"
          ? "request-failed"
          : null,
    };
  }
  async function checkCandidate(automatic: boolean) {
    const ownerUserId = automatic ? await owner() : undefined;
    if (automatic && !ownerUserId) return false;
    const lease = await store.claimCheck(automatic, ownerUserId ?? undefined);
    if (!lease) return false;
    try {
      const candidate = await adapter.check();
      if (
        candidate &&
        (!/^[a-f0-9]{40}$/.test(candidate.revision) ||
          !candidate.version ||
          candidate.version.length > 200)
      )
        throw new Error("Invalid update candidate");
      return store.finishCheck(lease, candidate, false);
    } catch {
      await store.finishCheck(lease, null, true);
      return false;
    }
  }
  async function dispatch(request: ServerUpdateRequest, actor?: ServerUpdateActor) {
    try {
      if (stopped || !(await store.begin(request.id))) return;
      const currentOwnerId = await owner();
      if (!currentOwnerId) {
        await store.settle(request.id, "failed");
        return;
      }
      if (actor) await authorize(actor);
      const control = await store.control();
      if (
        control.delegatedAccountKey !== request.delegatedAccountKey ||
        control.channel !== adapter.channel ||
        (request.automatic &&
          (!control.automatic ||
            control.consentedAccountKey !== delegatedAccountKey ||
            control.consentedUserId !== currentOwnerId ||
            control.policyRevision !== request.policyRevision))
      ) {
        await store.settle(request.id, "failed");
        return;
      }
      if (stopped) {
        await store.settle(request.id, "failed");
        return;
      }
    } catch {
      await store.settle(request.id, "failed");
      return;
    }
    // Submission is outside every transaction. An ambiguous transport outcome is never retried.
    try {
      await adapter.submit();
      await store.settle(request.id, "requested");
    } catch {
      await store.settle(request.id, "unknown");
    }
  }
  async function tick() {
    const currentOwnerId = await owner();
    if (stopped || !currentOwnerId) return;
    await store.ensure();
    await store.recover();
    const control = await store.control();
    if (
      !control.automatic ||
      control.consentedAccountKey !== delegatedAccountKey ||
      control.consentedUserId !== currentOwnerId ||
      !(await checkCandidate(true)) ||
      !(await owner()) ||
      stopped
    )
      return;
    const updated = await store.control();
    if (
      !updated.candidateRevision ||
      updated.candidateRevision === options.currentRevision ||
      !options.currentRevision
    )
      return;
    const queued = await store.queue({
      revision: updated.candidateRevision,
      idempotencyKey: randomUUID(),
      automatic: true,
      policyRevision: control.policyRevision,
      ownerUserId: currentOwnerId,
    });
    if (queued?.created) await dispatch(queued.request);
  }
  function action<T>(actor: ServerUpdateActor, work: () => Promise<T>): Promise<T> {
    const task = system(async () => {
      try {
        await authorize(actor);
        await store.ensure();
        return await work();
      } catch (error) {
        if (error instanceof ServerUpdateConflict) throw new ORPCError("CONFLICT");
        throw error;
      }
    });
    track(task);
    return task;
  }
  return {
    status: (actor: ServerUpdateActor) => action(actor, snapshot),
    check: (actor: ServerUpdateActor) =>
      action(actor, async () => {
        await checkCandidate(false);
        return snapshot();
      }),
    apply: (
      actor: ServerUpdateActor,
      input: { candidateRevision: string; idempotencyKey: string },
    ) =>
      action(actor, async () => {
        // The candidate is only a hint: this adapter redeploys its operator-configured channel.
        const queued = await store.queue({
          revision: input.candidateRevision,
          idempotencyKey: input.idempotencyKey,
          automatic: false,
        });
        if (queued?.created) track(system(() => dispatch(queued.request, { ...actor })));
        return snapshot();
      }),
    policy: (actor: ServerUpdateActor, input: { automatic: boolean; expectedRevision: number }) =>
      action(actor, async () => {
        await store.policy(input.automatic, input.expectedRevision, actor.userId);
        return snapshot();
      }),
    start() {
      if (timer || stopped) return;
      track(system(tick));
      timer = setInterval(() => track(system(tick)), 60_000);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([...pending]);
    },
  };
}
export type ServerUpdatesService = ReturnType<typeof createServerUpdates>;
