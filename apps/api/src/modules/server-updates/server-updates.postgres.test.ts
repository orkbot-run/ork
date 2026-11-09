// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { ServerUpdateAdapter } from "@orkbot/adapter-kit";
import { nativeSessionIdentityKey } from "@orkbot/auth";
import {
  bootstrapUserSpace,
  createDb,
  runAsSystem,
  runAsTenant,
  serverUpdateStore,
} from "@orkbot/db";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oidcAccountSubject } from "../../../../../packages/auth/src/oidc.js";
import { createPendingServerUpdates, createServerUpdates } from "./service.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.COPY_TEST_DATABASE && process.env.DATABASE_URL);
const database = enabled
  ? createDb(process.env.DATABASE_URL!, { encryptContent: false, poolMax: 2 })
  : undefined;
const prisma = database?.prisma;
const issuer = "https://accounts.example.test";
const ownerKey = oidcAccountSubject(issuer, "operator-owner");
const currentRevision = "a".repeat(40);
const revision = "b".repeat(40);
const system = <T>(fn: () => Promise<T>) => runAsSystem("server update integration test", fn);
const services: ReturnType<typeof createServerUpdates>[] = [];
let actor: { userId: string; sessionId: string };
let installationId: string;
function adapter(): ServerUpdateAdapter {
  return {
    channel: "preview",
    check: vi.fn(async () => ({ revision, version: "edge" })),
    submit: vi.fn(async (_revision, beforeSubmit) => {
      await beforeSubmit();
    }),
  };
}
function service(deployment = adapter()) {
  const result = createServerUpdates({
    prisma: prisma!,
    adapter: deployment,
    installationId,
    delegatedAccountKey: ownerKey,
    issuer,
    currentRevision,
  });
  services.push(result);
  return result;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function terminal() {
  await vi.waitFor(async () => {
    const request = await system(() =>
      prisma!.serverUpdateRequest.findFirst({
        where: { installationId },
        orderBy: { createdAt: "desc" },
      }),
    );
    expect(["requested", "unknown", "failed"]).toContain(request?.state);
  });
}

describe.skipIf(!enabled)("operator-delegated configured-channel server updates", () => {
  beforeEach(async () =>
    system(async () => {
      await prisma!.serverUpdateRequest.deleteMany({});
      await prisma!.serverUpdateControl.deleteMany({});
      await prisma!.organization.deleteMany({});
      await prisma!.user.deleteMany({ where: { email: { endsWith: "@example.test" } } });
      installationId = randomUUID();
      actor = { userId: randomUUID(), sessionId: randomUUID() };
      await prisma!.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", nativeAccountsOwnerKey: ownerKey },
        update: { nativeAccountsOwnerKey: ownerKey },
      });
      await prisma!.user.create({
        data: {
          id: actor.userId,
          name: "Operator",
          email: "operator@example.test",
          emailVerified: true,
        },
      });
      await prisma!.account.create({
        data: { id: randomUUID(), userId: actor.userId, providerId: "oidc", accountId: ownerKey },
      });
      await bootstrapUserSpace(
        prisma!,
        { id: actor.userId },
        { signupsEnabled: "true", signupAllowlist: "" },
      );
      await prisma!.session.create({
        data: {
          id: actor.sessionId,
          userId: actor.userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await prisma!.verification.create({
        data: {
          id: randomUUID(),
          identifier: nativeSessionIdentityKey(actor.sessionId),
          value: JSON.stringify([issuer, actor.userId, ownerKey]),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }),
  );
  afterEach(async () => {
    await Promise.all(services.splice(0).map((item) => item.stop()));
  });
  afterAll(async () => database?.pool.end());

  it("binds a pending standalone installation to the initialized owner once", async () => {
    const pending = createPendingServerUpdates({
      prisma: prisma!,
      adapter: adapter(),
      installationId,
      delegatedAccountKey: null,
      issuer,
      currentRevision,
    });
    services.push(pending);
    await system(() =>
      prisma!.deploymentSettings.update({
        where: { id: "default" },
        data: { nativeAccountsOwnerKey: null },
      }),
    );
    expect(await pending.status(actor)).toMatchObject({ available: false });
    await system(() =>
      prisma!.deploymentSettings.update({
        where: { id: "default" },
        data: { nativeAccountsOwnerKey: ownerKey },
      }),
    );
    expect(await pending.status(actor)).toMatchObject({ available: true });
    await system(() =>
      prisma!.deploymentSettings.update({
        where: { id: "default" },
        data: { nativeAccountsOwnerKey: "f".repeat(64) },
      }),
    );
    await expect(pending.status(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (
        await system(() =>
          prisma!.serverUpdateControl.findUniqueOrThrow({ where: { id: installationId } }),
        )
      ).delegatedAccountKey,
    ).toBe(ownerKey);
  });

  it("changes a selectable channel and invalidates candidates before applying", async () => {
    const deployment = { ...adapter(), channelSelectable: true };
    const updates = service(deployment);
    const checked = await updates.check(actor);
    expect(checked.candidate?.revision).toBe(revision);
    const changed = await updates.policy(actor, {
      automatic: false,
      expectedRevision: checked.policyRevision,
      channel: "stable",
    });
    expect(changed).toMatchObject({ channel: "stable", channelSelectable: true, candidate: null });
    await expect(
      updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await updates.check(actor);
    expect(deployment.check).toHaveBeenLastCalledWith("stable");
  });

  it("confirms completion only when the running revision matches the successful operation", async () => {
    const key = randomUUID();
    const deployment = {
      ...adapter(),
      operation: vi.fn(async () => ({
        revision,
        idempotencyKey: key,
        state: "succeeded" as const,
      })),
    };
    const previous = service(deployment);
    await previous.status(actor);
    await system(() =>
      prisma!.serverUpdateRequest.create({
        data: {
          installationId,
          idempotencyKey: key,
          revision,
          state: "requested",
          automatic: false,
          policyRevision: 0,
          delegatedAccountKey: ownerKey,
        },
      }),
    );
    expect((await previous.status(actor)).lastRequest).toMatchObject({
      state: "requested",
      phase: "verifying",
    });
    const updated = createServerUpdates({
      prisma: prisma!,
      adapter: deployment,
      installationId,
      delegatedAccountKey: ownerKey,
      issuer,
      currentRevision: revision,
    });
    services.push(updated);
    const completed = (await updated.status(actor)).lastRequest;
    expect(completed?.state).toBe("completed");
    expect(completed?.phase).toBeUndefined();
  });

  it("reports progress only for the matching active deployment", async () => {
    const key = randomUUID();
    const deployment = {
      ...adapter(),
      operation: vi.fn(async () => ({
        revision,
        idempotencyKey: key,
        state: "running" as const,
        phase: "downloading" as const,
      })),
    };
    const updates = service(deployment);
    await updates.status(actor);
    await system(() =>
      prisma!.serverUpdateRequest.create({
        data: {
          installationId,
          idempotencyKey: key,
          revision,
          state: "requested",
          automatic: false,
          policyRevision: 0,
          delegatedAccountKey: ownerKey,
        },
      }),
    );
    expect((await updates.status(actor)).lastRequest).toMatchObject({
      state: "requested",
      phase: "downloading",
    });
    deployment.operation.mockResolvedValueOnce({
      revision: "c".repeat(40),
      idempotencyKey: key,
      state: "running",
      phase: "downloading",
    });
    expect((await updates.status(actor)).lastRequest?.phase).toBeUndefined();
    deployment.operation.mockResolvedValueOnce({
      revision,
      idempotencyKey: randomUUID(),
      state: "running",
      phase: "downloading",
    });
    expect((await updates.status(actor)).lastRequest?.phase).toBeUndefined();
  });

  it("uses confirmed operation states when an older updater does not report a phase", async () => {
    const key = randomUUID();
    const operation = vi.fn<NonNullable<ServerUpdateAdapter["operation"]>>();
    const updates = service({ ...adapter(), operation });
    await updates.status(actor);
    await system(() =>
      prisma!.serverUpdateRequest.create({
        data: {
          installationId,
          idempotencyKey: key,
          revision,
          state: "requested",
          automatic: false,
          policyRevision: 0,
          delegatedAccountKey: ownerKey,
        },
      }),
    );
    operation.mockResolvedValueOnce({ revision, idempotencyKey: key, state: "accepted" });
    expect((await updates.status(actor)).lastRequest?.phase).toBe("preparing");
    operation.mockResolvedValueOnce({ revision, idempotencyKey: key, state: "running" });
    expect((await updates.status(actor)).lastRequest?.phase).toBe("updating");
    operation.mockResolvedValueOnce(null);
    expect((await updates.status(actor)).lastRequest?.phase).toBeUndefined();
  });

  it("does not change channels while an old deployment is unresolved", async () => {
    const key = randomUUID();
    const deployment = {
      ...adapter(),
      channelSelectable: true,
      operation: vi.fn(async () => ({ revision, idempotencyKey: key, state: "running" as const })),
    };
    const updates = service(deployment);
    await updates.status(actor);
    await system(() =>
      prisma!.serverUpdateRequest.create({
        data: {
          installationId,
          idempotencyKey: key,
          revision,
          state: "requested",
          automatic: false,
          policyRevision: 0,
          delegatedAccountKey: ownerKey,
          createdAt: new Date(Date.now() - 2 * 60 * 60_000),
        },
      }),
    );
    await expect(
      updates.policy(actor, { automatic: false, expectedRevision: 0, channel: "stable" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires the exact live native identity, not a role, linked account, or old issuer-only proof", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    expect(await updates.status(actor)).toMatchObject({
      available: true,
      mode: "manual",
      candidate: null,
      policyRevision: 0,
    });
    const legacyOwner = { ...actor, isDeploymentOwner: true };
    await system(() =>
      prisma!.verification.updateMany({
        where: { identifier: nativeSessionIdentityKey(actor.sessionId) },
        data: { value: JSON.stringify([issuer, actor.userId]) },
      }),
    );
    await expect(updates.status(legacyOwner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const foreignKey = oidcAccountSubject(issuer, "different-linked-identity");
    await system(() =>
      prisma!.account.create({
        data: { id: randomUUID(), userId: actor.userId, providerId: "oidc", accountId: foreignKey },
      }),
    );
    await system(() =>
      prisma!.verification.updateMany({
        where: { identifier: nativeSessionIdentityKey(actor.sessionId) },
        data: { value: JSON.stringify([issuer, actor.userId, foreignKey]) },
      }),
    );
    await expect(updates.check(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await system(() =>
      prisma!.verification.updateMany({
        where: { identifier: nativeSessionIdentityKey(actor.sessionId) },
        data: { value: JSON.stringify([issuer, actor.userId, ownerKey]) },
      }),
    );
    await expect(updates.status({ userId: actor.userId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await system(() =>
      prisma!.session.update({
        where: { id: actor.sessionId },
        data: { expiresAt: new Date(Date.now() - 1) },
      }),
    );
    await expect(updates.status(actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deployment.check).not.toHaveBeenCalled();
    expect(deployment.submit).not.toHaveBeenCalled();
  });

  it("keeps automatic consent explicit and protects it with a policy revision", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    expect(await updates.policy(actor, { automatic: true, expectedRevision: 0 })).toMatchObject({
      mode: "automatic",
      policyRevision: 1,
    });
    expect(
      await system(() => prisma!.serverUpdateControl.findUnique({ where: { id: installationId } })),
    ).toMatchObject({ consentedAccountKey: ownerKey });
    await expect(
      updates.policy(actor, { automatic: false, expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await updates.policy(actor, { automatic: false, expectedRevision: 1 })).toMatchObject({
      mode: "manual",
      policyRevision: 2,
    });
    expect(
      await system(() => prisma!.serverUpdateControl.findUnique({ where: { id: installationId } })),
    ).toMatchObject({ consentedAccountKey: null });
    expect(deployment.check).not.toHaveBeenCalled();
    expect(deployment.submit).not.toHaveBeenCalled();
  });

  it("leases checks across API instances without holding a database connection over the network", async () => {
    const response = deferred<{ revision: string; version: string }>();
    const deployment = adapter();
    vi.mocked(deployment.check).mockReturnValue(response.promise);
    const first = service(deployment);
    const second = service(deployment);
    const checking = first.check(actor);
    await vi.waitFor(() => expect(deployment.check).toHaveBeenCalledOnce());
    await expect(second.check(actor)).resolves.toMatchObject({ available: true });
    expect(await system(() => prisma!.session.count())).toBe(1);
    response.resolve({ revision, version: "edge" });
    expect(await checking).toMatchObject({ candidate: { revision, version: "edge" } });
    await second.check(actor);
    expect(deployment.check).toHaveBeenCalledOnce();
  });

  it("records one durable request before submission and never repeats an idempotency key", async () => {
    const response = deferred<void>();
    const deployment = adapter();
    vi.mocked(deployment.submit).mockImplementation(async (_revision, beforeSubmit) => {
      await beforeSubmit();
      expect(
        await system(() =>
          prisma!.serverUpdateRequest.count({ where: { installationId, state: "submitting" } }),
        ),
      ).toBe(1);
      await response.promise;
    });
    const updates = service(deployment);
    await updates.check(actor);
    const input = { candidateRevision: revision, idempotencyKey: randomUUID() };
    const statuses = await Promise.all([
      updates.apply(actor, input),
      service(deployment).apply(actor, input),
    ]);
    expect(
      statuses.every(
        (status) =>
          status.lastRequest?.revision === revision &&
          status.lastRequest?.id === input.idempotencyKey,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(deployment.submit).toHaveBeenCalledOnce());
    expect(deployment.submit).toHaveBeenCalledWith(
      revision,
      expect.any(Function),
      input.idempotencyKey,
      "preview",
    );
    expect(await system(() => prisma!.session.count())).toBe(1);
    await expect(
      updates.apply(actor, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    response.resolve();
    await terminal();
    expect(await updates.status(actor)).toMatchObject({
      currentRevision,
      lastRequest: { state: "requested", revision },
    });
    await updates.apply(actor, input);
    expect(deployment.submit).toHaveBeenCalledOnce();
  });

  it("does not retransmit an uncertain request after a timeout or an API restart", async () => {
    const deployment = adapter();
    vi.mocked(deployment.submit).mockImplementation(async (_revision, beforeSubmit) => {
      await beforeSubmit();
      throw new Error("Ambiguous transport failure");
    });
    const updates = service(deployment);
    await updates.check(actor);
    const input = { candidateRevision: revision, idempotencyKey: randomUUID() };
    await updates.apply(actor, input);
    await terminal();
    expect(await service(deployment).apply(actor, input)).toMatchObject({
      lastRequest: { state: "unknown" },
      error: "request-failed",
    });
    expect(deployment.submit).toHaveBeenCalledOnce();
    await expect(
      updates.apply(actor, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recovers stale submitting records as unknown and allows only explicit retries after one hour", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    await updates.check(actor);
    const id = randomUUID();
    const key = randomUUID();
    await system(() =>
      prisma!.serverUpdateRequest.create({
        data: {
          id,
          installationId,
          idempotencyKey: key,
          revision,
          state: "submitting",
          automatic: false,
          policyRevision: 0,
          delegatedAccountKey: ownerKey,
          createdAt: new Date(Date.now() - 120_000),
          updatedAt: new Date(Date.now() - 120_000),
        },
      }),
    );
    expect(await updates.status(actor)).toMatchObject({ lastRequest: { state: "unknown" } });
    await updates.apply(actor, { candidateRevision: revision, idempotencyKey: key });
    expect(deployment.submit).not.toHaveBeenCalled();
    await expect(
      updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await system(() =>
      prisma!.serverUpdateRequest.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 3_600_001) },
      }),
    );
    await updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() });
    await terminal();
    expect(deployment.submit).toHaveBeenCalledOnce();
  });

  it("checks automatic policies when due but never automatically requests a candidate twice", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    await updates.policy(actor, { automatic: true, expectedRevision: 0 });
    updates.start();
    await vi.waitFor(() => expect(deployment.submit).toHaveBeenCalledOnce());
    await terminal();
    await updates.stop();
    await system(() =>
      prisma!.serverUpdateControl.update({
        where: { id: installationId },
        data: { nextCheckAt: new Date(Date.now() - 1) },
      }),
    );
    const resumed = service(deployment);
    resumed.start();
    await vi.waitFor(() => expect(deployment.check).toHaveBeenCalledTimes(2));
    await resumed.stop();
    expect(deployment.submit).toHaveBeenCalledOnce();
  });

  it("discovers updates periodically without automatically submitting them", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    updates.start();
    await vi.waitFor(() => expect(deployment.check).toHaveBeenCalledOnce());
    await vi.waitFor(async () =>
      expect((await updates.status(actor)).candidate?.revision).toBe(revision),
    );
    expect(deployment.submit).not.toHaveBeenCalled();
  });

  it("stops automatic submissions after owner unlink and after consent is revoked during a check", async () => {
    const response = deferred<{ revision: string; version: string }>();
    const deployment = adapter();
    vi.mocked(deployment.check).mockReturnValue(response.promise);
    const updates = service(deployment);
    await updates.policy(actor, { automatic: true, expectedRevision: 0 });
    updates.start();
    await vi.waitFor(() => expect(deployment.check).toHaveBeenCalledOnce());
    await updates.policy(actor, { automatic: false, expectedRevision: 1 });
    response.resolve({ revision, version: "edge" });
    await updates.stop();
    expect(deployment.submit).not.toHaveBeenCalled();
    await updates.policy(actor, { automatic: true, expectedRevision: 2 });
    await system(() =>
      prisma!.account.deleteMany({ where: { userId: actor.userId, accountId: ownerKey } }),
    );
    const resumed = service(deployment);
    resumed.start();
    await resumed.stop();
    expect(deployment.submit).not.toHaveBeenCalled();
  });

  it("fences late check results and allows unrelated installation checks concurrently", async () => {
    await system(async () => {
      const binding = {
        installationId,
        delegatedAccountKey: ownerKey,
        channel: "preview" as const,
        currentRevision,
      };
      const first = serverUpdateStore(prisma!, binding);
      const second = serverUpdateStore(prisma!, binding);
      await first.ensure();
      const old = await first.claimCheck(false);
      expect(old).not.toBeNull();
      await prisma!.serverUpdateControl.update({
        where: { id: installationId },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      const replacement = await second.claimCheck(false);
      expect(replacement).not.toBeNull();
      expect(
        await first.finishCheck(old!, { revision: "c".repeat(40), version: "stale" }, false),
      ).toBe(false);
      expect(await second.finishCheck(replacement!, { revision, version: "edge" }, false)).toBe(
        true,
      );
      expect(await first.control()).toMatchObject({ candidateRevision: revision });
      const other = serverUpdateStore(prisma!, { ...binding, installationId: randomUUID() });
      await other.ensure();
      expect(await other.claimCheck(false)).not.toBeNull();
      expect(await first.control()).toMatchObject({ candidateRevision: revision });
    });
  });

  it.each(["requested", "unknown", "failed"])(
    "never automatically submits a %s candidate again, even beyond the cooldown",
    async (state) => {
      await system(async () => {
        const store = serverUpdateStore(prisma!, {
          installationId,
          delegatedAccountKey: ownerKey,
          channel: "preview",
          currentRevision,
        });
        await store.ensure();
        await store.policy(true, 0, actor.userId);
        const lease = await store.claimCheck(false);
        await store.finishCheck(lease!, { revision, version: "edge" }, false);
        await prisma!.serverUpdateRequest.create({
          data: {
            installationId,
            idempotencyKey: randomUUID(),
            revision,
            state,
            automatic: true,
            policyRevision: 1,
            delegatedAccountKey: ownerKey,
            createdAt: new Date(Date.now() - 7_200_000),
          },
        });
        expect(
          await store.queue({
            revision,
            idempotencyKey: randomUUID(),
            automatic: true,
            policyRevision: 1,
            ownerUserId: actor.userId,
          }),
        ).toBeNull();
        const manual = await store.queue({
          revision,
          idempotencyKey: randomUUID(),
          automatic: false,
        });
        expect(manual?.created).toBe(true);
        const winners = await Promise.all([
          store.begin(manual!.request.id),
          store.begin(manual!.request.id),
        ]);
        expect(winners.filter(Boolean)).toHaveLength(1);
      });
    },
  );

  it("does not offer or submit a candidate checked from a different running revision", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    await updates.check(actor);
    const replaced = createServerUpdates({
      prisma: prisma!,
      adapter: deployment,
      installationId,
      delegatedAccountKey: ownerKey,
      issuer,
      currentRevision: "c".repeat(40),
    });
    services.push(replaced);
    expect(await replaced.status(actor)).toMatchObject({
      candidate: null,
      currentRevision: "c".repeat(40),
    });
    await expect(
      replaced.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deployment.submit).not.toHaveBeenCalled();
  });

  it("requires fresh automatic consent when the same Accounts owner is recreated after deletion", async () => {
    const deployment = adapter();
    const updates = service(deployment);
    await updates.policy(actor, { automatic: true, expectedRevision: 0 });
    await system(async () => {
      await prisma!.user.delete({ where: { id: actor.userId } });
      expect(
        await prisma!.serverUpdateControl.findUnique({ where: { id: installationId } }),
      ).toMatchObject({ consentedUserId: null });
      actor = { userId: randomUUID(), sessionId: randomUUID() };
      await prisma!.user.create({
        data: {
          id: actor.userId,
          name: "Returned owner",
          email: "returned@example.test",
          emailVerified: true,
        },
      });
      await prisma!.account.create({
        data: { id: randomUUID(), userId: actor.userId, providerId: "oidc", accountId: ownerKey },
      });
      await bootstrapUserSpace(
        prisma!,
        { id: actor.userId },
        { signupsEnabled: "true", signupAllowlist: "" },
      );
      await prisma!.session.create({
        data: {
          id: actor.sessionId,
          userId: actor.userId,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await prisma!.verification.create({
        data: {
          id: randomUUID(),
          identifier: nativeSessionIdentityKey(actor.sessionId),
          value: JSON.stringify([issuer, actor.userId, ownerKey]),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    });
    expect(await updates.status(actor)).toMatchObject({ mode: "manual", policyRevision: 1 });
    updates.start();
    await updates.stop();
    expect(deployment.check).not.toHaveBeenCalled();
    expect(deployment.submit).not.toHaveBeenCalled();
    expect(
      await service(deployment).policy(actor, { automatic: true, expectedRevision: 1 }),
    ).toMatchObject({ mode: "automatic", policyRevision: 2 });
  });

  it("keeps installation controls and history invisible to a tenant", async () => {
    const updates = service();
    await updates.status(actor);
    const membership = await system(() =>
      prisma!.spaceMember.findFirstOrThrow({ where: { userId: actor.userId } }),
    );
    await runAsTenant({ userId: actor.userId, spaceId: membership.spaceId }, async () => {
      expect(await prisma!.serverUpdateControl.findMany()).toEqual([]);
      expect(await prisma!.serverUpdateRequest.findMany()).toEqual([]);
      await expect(
        prisma!.serverUpdateControl.create({
          data: { id: randomUUID(), delegatedAccountKey: ownerKey, channel: "preview" },
        }),
      ).rejects.toThrow();
    });
  });

  it.each(["consent", "renewed-consent", "session", "owner", "intent"] as const)(
    "refuses deployment after %s retirement during final asynchronous eligibility",
    async (reason) => {
      const eligibility = deferred<void>();
      const entered = deferred<void>();
      const finished = deferred<void>();
      const post = vi.fn();
      const deployment = adapter();
      vi.mocked(deployment.submit).mockImplementation(
        async (_revision, beforeSubmit: () => Promise<void>) => {
          try {
            entered.resolve();
            await eligibility.promise;
            await beforeSubmit();
            post();
          } finally {
            finished.resolve();
          }
        },
      );
      const updates = service(deployment);
      try {
        if (reason === "consent" || reason === "renewed-consent") {
          await updates.policy(actor, { automatic: true, expectedRevision: 0 });
          updates.start();
        } else {
          await updates.check(actor);
          await updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() });
        }
        await entered.promise;
        if (reason === "consent" || reason === "renewed-consent") {
          await updates.policy(actor, { automatic: false, expectedRevision: 1 });
          if (reason === "renewed-consent")
            await updates.policy(actor, { automatic: true, expectedRevision: 2 });
        } else if (reason === "session")
          await system(() =>
            prisma!.session.update({
              where: { id: actor.sessionId },
              data: { expiresAt: new Date(0) },
            }),
          );
        else if (reason === "owner")
          await system(() =>
            prisma!.account.deleteMany({ where: { userId: actor.userId, accountId: ownerKey } }),
          );
        else
          await system(() =>
            prisma!.serverUpdateRequest.updateMany({
              where: { installationId, state: "submitting" },
              data: { state: "unknown" },
            }),
          );
        eligibility.resolve();
        await finished.promise;
        await terminal();
        expect(post).not.toHaveBeenCalled();
        const request = await system(() =>
          prisma!.serverUpdateRequest.findFirstOrThrow({ where: { installationId } }),
        );
        expect(request.state).toBe(reason === "intent" ? "unknown" : "failed");
      } finally {
        eligibility.resolve();
      }
    },
  );

  it("records failed rather than unknown when final eligibility fails before submission admission", async () => {
    const deployment = adapter();
    vi.mocked(deployment.submit).mockRejectedValueOnce(new Error("Final eligibility unavailable"));
    const updates = service(deployment);
    await updates.check(actor);
    await updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() });
    await terminal();
    expect(await updates.status(actor)).toMatchObject({ lastRequest: { state: "failed" } });
  });

  it("stops a pending eligibility check before its deployment POST", async () => {
    const eligibility = deferred<void>();
    const entered = deferred<void>();
    const post = vi.fn();
    const deployment = adapter();
    vi.mocked(deployment.submit).mockImplementation(async (_revision, beforeSubmit) => {
      entered.resolve();
      await eligibility.promise;
      await beforeSubmit();
      post();
    });
    const updates = service(deployment);
    try {
      await updates.check(actor);
      await updates.apply(actor, { candidateRevision: revision, idempotencyKey: randomUUID() });
      await entered.promise;
      const stopping = updates.stop();
      eligibility.resolve();
      await stopping;
      expect(post).not.toHaveBeenCalled();
      expect(await updates.status(actor)).toMatchObject({ lastRequest: { state: "failed" } });
    } finally {
      eligibility.resolve();
    }
  });
});
