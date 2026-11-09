// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import { verifiedNativeSessionIdentity } from "@orkbot/auth";
import type { ServerUpdatePhase, ServerUpdatesStatus } from "@orkbot/contracts";
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
  const storeFor = (channel: "stable" | "preview") =>
    serverUpdateStore(prisma, {
      ...options,
      channel,
      channelSelectable: adapter.channelSelectable === true,
    });
  const store = storeFor(adapter.channel);
  async function channelStore() {
    const control = await store.control();
    if (control.channel !== "stable" && control.channel !== "preview")
      throw new ServerUpdateConflict("Invalid channel");
    const channel: "stable" | "preview" = control.channel;
    return { channel, store: storeFor(channel) };
  }
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
    let state = last?.state === "queued" ? "submitting" : last?.state;
    let phase: ServerUpdatePhase | undefined;
    if (last && adapter.operation && ["requested", "unknown", "submitting"].includes(state ?? "")) {
      const operation = await adapter.operation();
      if (
        operation?.idempotencyKey === last.idempotencyKey &&
        operation.revision === last.revision
      ) {
        if (operation.state === "succeeded" && options.currentRevision === last.revision)
          state = "completed";
        else if (operation.state === "failed") state = "failed";
        else if (operation.state === "unknown") state = "unknown";
        else if (operation.state === "accepted" || operation.state === "running")
          state = "requested";
        if (operation.state === "accepted" || operation.state === "running")
          phase = operation.phase ?? (operation.state === "accepted" ? "preparing" : "updating");
        else if (operation.state === "succeeded" && state !== "completed") phase = "verifying";
      }
    }
    return {
      available: true,
      mode:
        control.automatic &&
        control.consentedAccountKey === delegatedAccountKey &&
        control.consentedUserId === currentOwnerId &&
        currentOwnerId
          ? "automatic"
          : "manual",
      channel: control.channel as "stable" | "preview",
      channelSelectable: adapter.channelSelectable === true,
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
            ...(phase ? { phase } : {}),
          }
        : null,
      error: control.checkFailed
        ? "check-failed"
        : state === "unknown" || state === "failed"
          ? "request-failed"
          : null,
    };
  }
  async function checkCandidate(automatic: boolean, periodic = false) {
    const ownerUserId = automatic ? await owner() : undefined;
    if (automatic && !ownerUserId) return false;
    const active = await channelStore();
    const lease = await active.store.claimCheck(automatic, ownerUserId ?? undefined, periodic);
    if (!lease) return false;
    try {
      const candidate = await adapter.check(active.channel);
      if (
        candidate &&
        (!/^[a-f0-9]{40}$/.test(candidate.revision) ||
          !candidate.version ||
          candidate.version.length > 200)
      )
        throw new Error("Invalid update candidate");
      return active.store.finishCheck(lease, candidate, false);
    } catch {
      await active.store.finishCheck(lease, null, true);
      return false;
    }
  }
  async function authorizeSubmission(request: ServerUpdateRequest, actor?: ServerUpdateActor) {
    const currentOwnerId = await owner();
    if (!currentOwnerId) throw new ORPCError("FORBIDDEN");
    if (actor) await authorize(actor);
    const control = await store.control();
    if (
      control.delegatedAccountKey !== request.delegatedAccountKey ||
      (!adapter.channelSelectable && control.channel !== adapter.channel) ||
      control.policyRevision !== request.policyRevision ||
      (request.automatic &&
        (!control.automatic ||
          control.consentedAccountKey !== delegatedAccountKey ||
          control.consentedUserId !== currentOwnerId ||
          control.policyRevision !== request.policyRevision)) ||
      !(await store.isSubmitting(request.id)) ||
      stopped
    )
      throw new ORPCError("FORBIDDEN");
  }
  async function dispatch(request: ServerUpdateRequest, actor?: ServerUpdateActor) {
    try {
      if (stopped || !(await store.begin(request.id))) return;
      await authorizeSubmission(request, actor);
    } catch {
      await store.settle(request.id, "failed");
      return;
    }
    // The adapter rechecks eligibility outside transactions, then checks live authority before POST.
    let submissionAuthorized = false;
    try {
      const { channel } = await channelStore();
      await adapter.submit(
        request.revision,
        async () => {
          await authorizeSubmission(request, actor);
          submissionAuthorized = true;
        },
        request.idempotencyKey,
        channel,
      );
      await store.settle(request.id, "requested");
    } catch {
      await store.settle(request.id, submissionAuthorized ? "unknown" : "failed");
    }
  }
  async function tick() {
    const currentOwnerId = await owner();
    if (stopped || !currentOwnerId) return;
    await store.ensure();
    await store.recover();
    const control = await store.control();
    if (!control.automatic) {
      await checkCandidate(false, true);
      return;
    }
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
    const active = await channelStore();
    const queued = await active.store.queue({
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
        const active = await channelStore();
        const queued = await active.store.queue({
          revision: input.candidateRevision,
          idempotencyKey: input.idempotencyKey,
          automatic: false,
        });
        if (queued?.created) track(system(() => dispatch(queued.request, { ...actor })));
        return snapshot();
      }),
    policy: (
      actor: ServerUpdateActor,
      input: { automatic: boolean; expectedRevision: number; channel?: "stable" | "preview" },
    ) =>
      action(actor, async () => {
        const active = await channelStore();
        if (input.channel && input.channel !== active.channel) {
          const last = await store.latest();
          if (last && ["queued", "submitting", "requested", "unknown"].includes(last.state)) {
            const operation = await adapter.operation?.();
            if (
              !operation ||
              operation.idempotencyKey !== last.idempotencyKey ||
              operation.revision !== last.revision ||
              (operation.state !== "failed" &&
                !(operation.state === "succeeded" && options.currentRevision === last.revision))
            )
              throw new ServerUpdateConflict("The last deployment has not been resolved");
          }
        }
        await active.store.policy(
          input.automatic,
          input.expectedRevision,
          actor.userId,
          input.channel,
        );
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

/** Bind the initialized Accounts owner once for a locally installed standalone server. */
export function createPendingServerUpdates(
  options: Omit<Parameters<typeof createServerUpdates>[0], "delegatedAccountKey"> & {
    delegatedAccountKey: null;
  },
): ServerUpdatesService {
  let active: ServerUpdatesService | undefined;
  let pending: Promise<ServerUpdatesService | null> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  async function resolve(): Promise<ServerUpdatesService | null> {
    if (stopped) return null;
    if (active) return active;
    pending ??= runAsSystem("bind initialized standalone update owner", async () => {
      const previous = await options.prisma.serverUpdateControl.findUnique({
        where: { id: options.installationId },
      });
      const ownerKey =
        previous?.delegatedAccountKey ??
        (
          await options.prisma.deploymentSettings.findUnique({
            where: { id: "default" },
            select: { nativeAccountsOwnerKey: true },
          })
        )?.nativeAccountsOwnerKey;
      if (!ownerKey || !/^[a-f0-9]{64}$/.test(ownerKey)) return null;
      const bound = await options.prisma.serverUpdateControl.upsert({
        where: { id: options.installationId },
        create: {
          id: options.installationId,
          delegatedAccountKey: ownerKey,
          channel: options.adapter.channel,
        },
        update: {},
      });
      if (stopped) return null;
      // Upsert preserves the first binding even when independent API instances race.
      active = createServerUpdates({ ...options, delegatedAccountKey: bound.delegatedAccountKey });
      active.start();
      return active;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  }
  return {
    status: async (...args) => (await resolve())?.status(...args) ?? unavailableServerUpdates(),
    check: async (...args) => (await resolve())?.check(...args) ?? unavailableServerUpdates(),
    apply: async (...args) => {
      const service = await resolve();
      if (!service) throw new ORPCError("FORBIDDEN");
      return service.apply(...args);
    },
    policy: async (...args) => {
      const service = await resolve();
      if (!service) throw new ORPCError("FORBIDDEN");
      return service.policy(...args);
    },
    start() {
      if (timer || stopped) return;
      void resolve().catch(() => undefined);
      timer = setInterval(() => void resolve().catch(() => undefined), 60_000);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await pending?.catch(() => undefined);
      await active?.stop();
    },
  };
}
