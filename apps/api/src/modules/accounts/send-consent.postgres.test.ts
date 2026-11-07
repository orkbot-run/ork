// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { aiRecipient, EncryptedSecretStore, findConnectedModelCredential } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { AI_DISCLOSURE_VERSION, OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  Prisma,
  provisionMessagingIdentity,
  runAsTenant,
} from "@orkbot/db";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";
import { resolveThreadTarget, sendThreadMessage } from "#modules/threads/thread-target";
import { handleRpcError } from "../../app.js";
import { aiConsentStatus, allowAiConsent, prepareSendAiConsent } from "./ai-consent.js";

const createHandler = (deps: RouterDeps) =>
  new RPCHandler(createRouter(deps), {
    clientInterceptors: [onError((error, { path }) => handleRpcError(error, path))],
  });
const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;
postgres("send consent acceptance (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let actor: Actor;
  let botId: string;
  let threadId: string;
  let routineId: string;
  let routineBotId: string;
  let secondRoutineId: string;
  let deps: RouterDeps;
  let handler: ReturnType<typeof createHandler>;
  const enqueue = vi.fn(async () => undefined);
  const modelRecipient = (provider: string, modelId: string) =>
    aiRecipient({ provider, modelId, use: "model" })!;
  const threadRecipient = modelRecipient("fixture-thread", "thread-model");
  const firstRecipient = modelRecipient("fixture-routine", "routine-model");
  const secondRecipient = modelRecipient("fixture-second", "second-model");

  beforeAll(() => {
    db = createDb(url!);
    prisma = asSystem(db.prisma);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.pool.end();
  });
  beforeEach(async () => {
    enqueue.mockClear();
    const identity = await provisionMessagingIdentity(
      prisma,
      { provider: "email", address: `send-consent-${randomUUID()}@example.test` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    ({ botId, threadId } = identity);
    actor = {
      userId: identity.userId,
      spaceId: identity.spaceId,
      email: "fixture@example.test",
      isDeploymentOwner: false,
    };
    await prisma.run.updateMany({
      where: { spaceId: actor.spaceId },
      data: { status: "cancelled" },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, name: "Routine bot", color: "blue" },
    });
    routineBotId = bot.id;
    await prisma.thread.create({
      data: { spaceId: actor.spaceId, userId: actor.userId, botId: bot.id },
    });
    const routine = async (provider: string, modelId: string) => {
      await prisma.userModelCredential.create({
        data: { userId: actor.userId, provider, label: "Fixture", secretId: `fixture-${provider}` },
      });
      return prisma.routine.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: bot.id,
          name: "Paused",
          prompt: "Fixture",
          active: false,
          modelProvider: provider,
          modelId,
          crons: [],
          timezone: "UTC",
        },
      });
    };
    routineId = (await routine("fixture-routine", "routine-model")).id;
    secondRoutineId = (await routine("fixture-second", "second-model")).id;
    deps = {
      prisma: db.prisma,
      events: createThreadEvents(db.prisma),
      jobs: { enqueue, cancel: vi.fn(), close: async () => undefined },
      secrets: { load: vi.fn(async () => "fixture-secret") },
      sandbox: {},
      agentSkills: { listWithContent: vi.fn(async () => []) },
      env: {
        agentRuntime: "pi",
        deploymentModelConfigured: true,
        defaultProvider: "fixture-thread",
        defaultModel: "thread-model",
      },
    } as unknown as RouterDeps;
    handler = createHandler(deps);
  });
  const call = async (path: string, input: Record<string, unknown>) => {
    const result = await runAsTenant(actor, () =>
      handler.handle(
        new Request(`http://127.0.0.1/rpc/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: input }),
        }),
        { prefix: "/rpc", context: { actor } },
      ),
    );
    return result.response!;
  };
  const grant = async (...keys: string[]) => {
    await prisma.aiDataConsent.createMany({
      data: keys.map((recipientKey) => ({
        userId: actor.userId,
        spaceId: actor.spaceId,
        recipientKey,
        version: AI_DISCLOSURE_VERSION,
      })),
    });
  };
  const effects = async () =>
    Promise.all([
      prisma.message.count({ where: { thread: { spaceId: actor.spaceId }, role: "user" } }),
      prisma.task.count({ where: { spaceId: actor.spaceId } }),
      prisma.run.count({ where: { spaceId: actor.spaceId } }),
    ]);
  const send = (text?: string) =>
    call("threads/sendWithRoutines", {
      botId,
      routineIds: [routineId, secondRoutineId],
      clientNonce: randomUUID(),
      ...(text ? { text } : {}),
    });

  it("resolves paused routines on another bot together with the active chat and grants that exact target", async () => {
    const target = {
      botId,
      routineIds: [routineId, secondRoutineId, routineId],
      uses: ["model"] as const,
    };
    const status = await runAsTenant(actor, () =>
      aiConsentStatus(deps, actor, { ...target, uses: [...target.uses] }),
    );
    expect(new Set(status.recipients.map((item) => item.key))).toEqual(
      new Set([threadRecipient.key, firstRecipient.key, secondRecipient.key]),
    );
    const allowed = await runAsTenant(actor, () =>
      allowAiConsent(deps, actor, {
        ...target,
        uses: [...target.uses],
        scope: status.scope,
        version: status.version,
        keys: [firstRecipient.key],
      }),
    );
    expect(allowed.recipients.find((item) => item.key === firstRecipient.key)?.allowed).toBe(true);
    expect(allowed.recipients.find((item) => item.key === secondRecipient.key)?.allowed).toBe(
      false,
    );
  });
  it("authorizes requested routines even when no model or voice disclosure is requested", async () => {
    const response = await call("aiConsent/status", {
      botId,
      routineIds: ["missing-routine"],
      uses: [],
    });
    expect(response.status).toBe(404);
    expect(await prisma.aiDataConsent.count({ where: { userId: actor.userId } })).toBe(0);
  });
  it("refuses an ordinary direct API send without the active chat recipient", async () => {
    const before = await effects();
    const response = await call("threads/send", { botId, text: "Fixture" });
    expect(response.status).toBe(403);
    expect(await effects()).toEqual(before);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([undefined, "Message and routines"])(
    "refuses a missing second routine grant without partial effects (%s)",
    async (text) => {
      await grant(threadRecipient.key, firstRecipient.key);
      const before = await effects();
      expect((await send(text)).status).toBe(403);
      expect(await effects()).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "Message and routines"])(
    "refuses a missing active-thread grant even when all routine grants exist (%s)",
    async (text) => {
      await grant(firstRecipient.key, secondRecipient.key);
      const before = await effects();
      expect((await send(text)).status).toBe(403);
      expect(await effects()).toEqual(before);
    },
  );
  it.each([undefined, "Message and routines"])(
    "accepts all effects together after every recipient is allowed (%s)",
    async (text) => {
      await grant(threadRecipient.key, firstRecipient.key, secondRecipient.key);
      const before = await effects();
      const response = await send(text);
      expect(response.status).toBe(200);
      expect((await response.json()).json.routineRunIds).toHaveLength(2);
      const after = await effects();
      expect(after[0] - before[0]).toBe(text ? 1 : 0);
      const runs = await prisma.run.findMany({
        where: { routineId: { in: [routineId, secondRoutineId] } },
        orderBy: { modelId: "asc" },
      });
      expect(runs.map((run) => [run.modelProvider, run.modelId])).toEqual([
        ["fixture-routine", "routine-model"],
        ["fixture-second", "second-model"],
      ]);
    },
  );
  it("includes every active group member plus paused mentioned routines in the same preflight", async () => {
    await prisma.bot.update({
      where: { id: routineBotId },
      data: { modelProvider: "fixture-routine", modelId: "group-model" },
    });
    const groupRecipient = modelRecipient("fixture-routine", "group-model");
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Fixture group",
        members: { create: [{ botId }, { botId: routineBotId }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
    });
    const status = await runAsTenant(actor, () =>
      aiConsentStatus(deps, actor, {
        groupId: group.id,
        routineIds: [routineId],
        uses: ["model"],
      }),
    );
    expect(new Set(status.recipients.map((item) => item.key))).toEqual(
      new Set([threadRecipient.key, firstRecipient.key, groupRecipient.key]),
    );
    await grant(threadRecipient.key, firstRecipient.key);
    const before = await effects();
    const input = {
      groupId: group.id,
      routineIds: [routineId],
      clientNonce: randomUUID(),
      text: "Group and routine",
    };
    expect((await call("threads/sendWithRoutines", input)).status).toBe(403);
    expect(await effects()).toEqual(before);
    await grant(groupRecipient.key);
    expect((await call("threads/sendWithRoutines", input)).status).toBe(200);
  });
  it("uses current group membership for consent and routing even when the outer target is stale", async () => {
    await prisma.bot.update({
      where: { id: routineBotId },
      data: { modelProvider: "fixture-routine", modelId: "group-model" },
    });
    const peer = await prisma.bot.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Remaining member",
        color: "blue",
      },
    });
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Changed group",
        members: { create: [{ botId }, { botId: routineBotId }, { botId: peer.id }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    await grant(threadRecipient.key);
    const target = await runAsTenant(actor, () =>
      resolveThreadTarget(deps.prisma, actor, { groupId: group.id }),
    );
    const preflight = await runAsTenant(actor, () =>
      prepareSendAiConsent(deps, actor, { groupId: group.id }),
    );
    await prisma.chatGroupMember.deleteMany({ where: { groupId: group.id, botId: routineBotId } });
    await runAsTenant(actor, () =>
      sendThreadMessage({ ...deps, consentPreflight: preflight }, actor, target, {
        text: "Current group only",
        clientNonce: randomUUID(),
      }),
    );
    const runs = await prisma.run.findMany({ where: { threadId: group.thread!.id } });
    expect(new Set(runs.map((run) => run.botId))).toEqual(new Set([botId, peer.id]));
    expect(
      await prisma.message.count({ where: { threadId: group.thread!.id, role: "user" } }),
    ).toBe(1);
  });
  it("holds the group thread stable while the real consent preflight is pending", async () => {
    const group = await prisma.chatGroup.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: "Stable admission group",
        members: { create: [{ botId }, { botId: routineBotId }] },
        thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    await grant(threadRecipient.key);
    const target = await runAsTenant(actor, () =>
      resolveThreadTarget(deps.prisma, actor, { groupId: group.id }),
    );
    const preflight = await runAsTenant(actor, () =>
      prepareSendAiConsent(deps, actor, { groupId: group.id }),
    );
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const sending = runAsTenant(actor, () =>
      sendThreadMessage(
        {
          ...deps,
          consentPreflight: async (tx) => {
            await preflight(tx);
            attempts += 1;
            started();
            await held;
          },
        },
        actor,
        target,
        { text: "Stable consent acceptance", clientNonce: randomUUID() },
      ),
    );
    await Promise.race([ready, sending]);
    let writerPid = 0;
    let writerFinished = false;
    const writer = prisma
      .$transaction(async (tx) => {
        const [connection] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        writerPid = connection!.pid;
        await tx.thread.update({ where: { id: group.thread!.id }, data: { unread: true } });
      })
      .finally(() => {
        writerFinished = true;
      });
    try {
      await vi.waitFor(async () => {
        expect(writerFinished).toBe(false);
        expect(writerPid).toBeGreaterThan(0);
        const [state] = await prisma.$queryRaw<Array<{ blockers: number }>>`
          SELECT cardinality(pg_blocking_pids(${writerPid})) AS blockers
        `;
        expect(state!.blockers).toBeGreaterThan(0);
      });
      expect(await prisma.message.count({ where: { threadId: group.thread!.id } })).toBe(0);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([sending, writer]);
    }
    expect(attempts).toBe(1);
    expect(
      await prisma.message.count({ where: { threadId: group.thread!.id, role: "user" } }),
    ).toBe(1);
    expect(await prisma.run.count({ where: { threadId: group.thread!.id } })).toBe(2);
  });
  it.each([1, 3])(
    "retries a real group send conflict within the three-attempt bound (%i conflicts)",
    async (conflicts) => {
      const group = await prisma.chatGroup.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Conflicting group",
          members: { create: [{ botId }, { botId: routineBotId }] },
          thread: { create: { spaceId: actor.spaceId, userId: actor.userId } },
        },
        include: { thread: true },
      });
      await grant(threadRecipient.key);
      const target = await runAsTenant(actor, () =>
        resolveThreadTarget(deps.prisma, actor, { groupId: group.id }),
      );
      const preflight = await runAsTenant(actor, () =>
        prepareSendAiConsent(deps, actor, { groupId: group.id }),
      );
      let attempts = 0;
      const conflicting = new Proxy(deps.prisma, {
        get(client, property) {
          if (property !== "$transaction") return Reflect.get(client, property);
          return (
            work: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options?: Parameters<PrismaClient["$transaction"]>[1],
          ) =>
            client.$transaction(
              (tx) =>
                work(
                  new Proxy(tx, {
                    get(transaction, method) {
                      const original = Reflect.get(transaction, method);
                      if (method !== "$queryRaw") return original;
                      return async (
                        ...query: [Prisma.Sql | TemplateStringsArray, ...unknown[]]
                      ) => {
                        const sql = query[0];
                        const statement = "strings" in sql ? sql.strings.join("") : sql.join("");
                        if (
                          statement.includes("FROM threads WHERE id =") &&
                          statement.includes("FOR UPDATE")
                        ) {
                          attempts += 1;
                          // The Space lock establishes a snapshot before the thread row lock.
                          if (attempts <= conflicts)
                            await prisma.thread.update({
                              where: { id: group.thread!.id },
                              data: { unread: attempts % 2 === 1 },
                            });
                        }
                        return Reflect.apply(original, transaction, query);
                      };
                    },
                  }),
                ),
              options,
            );
        },
      });
      const sending = runAsTenant(actor, () =>
        sendThreadMessage(
          {
            ...deps,
            prisma: conflicting,
            consentPreflight: preflight,
          },
          actor,
          target,
          { text: "One accepted group message", clientNonce: randomUUID() },
        ),
      );
      if (conflicts === 1) {
        await sending;
        expect(attempts).toBe(2);
        expect(
          await prisma.message.count({ where: { threadId: group.thread!.id, role: "user" } }),
        ).toBe(1);
        expect(await prisma.run.count({ where: { threadId: group.thread!.id } })).toBe(2);
      } else {
        const error = await sending.catch((failure: unknown) => failure);
        expect(error).toMatchObject({
          code: "P2010",
          meta: {
            driverAdapterError: {
              cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
            },
          },
        });
        expect(attempts).toBe(3);
        expect(await prisma.message.count({ where: { threadId: group.thread!.id } })).toBe(0);
        expect(await prisma.run.count({ where: { threadId: group.thread!.id } })).toBe(0);
        expect(enqueue).not.toHaveBeenCalled();
      }
    },
  );
  it("rejects a changed encrypted endpoint before any acceptance without loading a provider under the lock", async () => {
    await prisma.secret.create({
      data: {
        id: "fixture-fixture-routine",
        userId: actor.userId,
        kind: "model",
        ciphertext: "prepared-ciphertext",
      },
    });
    vi.mocked(deps.secrets.load).mockImplementation(async (ref) =>
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl:
          ref === "prepared-ciphertext"
            ? "https://first.example.test/v1"
            : "https://replacement.example.test/v1",
      }),
    );
    const target = { botId, routineIds: [routineId], uses: ["model"] as const };
    const status = await runAsTenant(actor, () =>
      aiConsentStatus(deps, actor, { ...target, uses: [...target.uses] }),
    );
    await grant(...status.recipients.map((item) => item.key));
    vi.mocked(deps.secrets.load).mockClear();
    const preflight = await runAsTenant(actor, () =>
      prepareSendAiConsent(deps, actor, { botId, routineIds: [routineId] }),
    );
    expect(deps.secrets.load).toHaveBeenCalledOnce();
    const before = await effects();
    await prisma.secret.update({
      where: { id: "fixture-fixture-routine" },
      data: { ciphertext: "replacement-ciphertext" },
    });
    await expect(
      prisma.$transaction(
        async (tx) => {
          await preflight(tx);
          await tx.message.create({ data: { threadId, seq: 998, role: "user", blocks: [] } });
        },
        { isolationLevel: "Serializable" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await effects()).toEqual(before);
    expect(deps.secrets.load).toHaveBeenCalledOnce();
  });
  const genericConnections = async () => {
    const store = new EncryptedSecretStore("test-only-consent-endpoint-key");
    const context = {
      userId: actor.userId,
      spaceId: actor.spaceId,
      operationId: "consent-test",
      traceId: "consent-test",
      signal: new AbortController().signal,
    };
    const create = async (
      label: string,
      endpoint: string,
      enabledModelIds: string[],
      updatedAt: Date,
    ) => {
      const secretId = randomUUID();
      const secret = await store.put(
        JSON.stringify({ kind: "openai_compatible", baseUrl: endpoint, enabledModelIds }),
        context,
        { recordId: secretId },
      );
      await prisma.secret.create({
        data: { id: secretId, userId: actor.userId, kind: "model", ciphertext: secret.ref },
      });
      return prisma.userModelCredential.create({
        data: {
          userId: actor.userId,
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          label,
          secretId,
          updatedAt,
        },
      });
    };
    const a = await create(
      "Preferred connection",
      "https://preferred.example.test/v1",
      ["model-y"],
      new Date("2026-01-02T00:00:00Z"),
    );
    const b = await create(
      "Enabled connection",
      "https://enabled.example.test/v1",
      ["model-x"],
      new Date("2026-01-01T00:00:00Z"),
    );
    await prisma.userModelPreference.create({
      data: { userId: actor.userId, credentialId: a.id, modelId: "model-y" },
    });
    deps.secrets = store;
    const load = vi.spyOn(store, "load");
    return {
      a,
      b,
      load,
      preferred: aiRecipient({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: "model-y",
        baseUrl: "https://preferred.example.test/v1",
        use: "model",
      })!,
      preferredForX: aiRecipient({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: "model-x",
        baseUrl: "https://preferred.example.test/v1",
        use: "model",
      })!,
      correct: aiRecipient({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: "model-x",
        baseUrl: "https://enabled.example.test/v1",
        use: "model",
      })!,
    };
  };
  it.each(["bot", "routine", "role"] as const)(
    "requires the runtime-selected encrypted endpoint for a %s model, not another connection's grant",
    async (kind) => {
      const { a, b, load, preferred, preferredForX, correct } = await genericConnections();
      if (kind === "bot")
        await prisma.bot.update({
          where: { id: botId },
          data: { modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: "model-x" },
        });
      else if (kind === "routine")
        await prisma.routine.update({
          where: { id: routineId },
          data: { modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: "model-x" },
        });
      else
        await prisma.userModelRoleChoice.create({
          data: {
            userId: actor.userId,
            role: "computer",
            position: 0,
            provider: OPENAI_COMPATIBLE_PROVIDER_ID,
            modelId: "model-x",
          },
        });
      const resolved = await runAsTenant(actor, () =>
        findConnectedModelCredential(
          deps.prisma,
          deps.secrets,
          actor,
          OPENAI_COMPATIBLE_PROVIDER_ID,
          "model-x",
        ),
      );
      expect(resolved?.id).toBe(b.id);
      expect(resolved?.id).not.toBe(a.id);
      const target = {
        botId,
        ...(kind === "routine" ? { routineIds: [routineId] } : {}),
        uses: ["model"] as const,
      };
      const status = await runAsTenant(actor, () =>
        aiConsentStatus(deps, actor, { ...target, uses: [...target.uses] }),
      );
      expect(status.recipients).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: correct.key, allowed: false })]),
      );
      // The default engagement judge uses provider-only resolution for a bot override;
      // a routine or an unbound role alone does not make that endpoint reachable.
      expect(status.recipients.some((recipient) => recipient.key === preferredForX.key)).toBe(
        kind === "bot",
      );
      await grant(preferred.key, preferredForX.key, threadRecipient.key);
      const before = await effects();
      const path = kind === "routine" ? "threads/sendWithRoutines" : "threads/send";
      const input = {
        botId,
        text: "Endpoint-specific permission",
        clientNonce: randomUUID(),
        ...(kind === "routine" ? { routineIds: [routineId] } : {}),
      };
      expect((await call(path, input)).status).toBe(403);
      expect(await effects()).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
      await grant(correct.key);
      const check = await runAsTenant(actor, () =>
        prepareSendAiConsent(deps, actor, { ...target, uses: [...target.uses] }),
      );
      const preparedLoads = load.mock.calls.length;
      await prisma.$transaction(check, { isolationLevel: "Serializable" });
      expect(load).toHaveBeenCalledTimes(preparedLoads);
      expect((await call(path, input)).status).toBe(200);
    },
  );
  it("keeps an explicitly pinned role on its reviewed connection instead of falling back to another enabled endpoint", async () => {
    const { a, b, preferred, preferredForX, correct } = await genericConnections();
    await prisma.userModelRoleChoice.create({
      data: {
        userId: actor.userId,
        role: "computer",
        position: 0,
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId: "model-x",
        credentialId: a.id,
      },
    });
    const pinned = await runAsTenant(actor, () =>
      findConnectedModelCredential(
        deps.prisma,
        deps.secrets,
        actor,
        OPENAI_COMPATIBLE_PROVIDER_ID,
        "model-x",
        { credentialId: a.id },
      ),
    );
    expect(pinned?.id).toBe(a.id);
    expect(pinned?.id).not.toBe(b.id);
    const status = await runAsTenant(actor, () =>
      aiConsentStatus(deps, actor, { botId, uses: ["model"] }),
    );
    expect(status.recipients.map((recipient) => recipient.key)).toContain(preferredForX.key);
    expect(status.recipients.map((recipient) => recipient.key)).not.toContain(correct.key);
    await grant(preferred.key, correct.key, threadRecipient.key);
    const before = await effects();
    expect((await call("threads/send", { botId, text: "Pinned endpoint" })).status).toBe(403);
    expect(await effects()).toEqual(before);
  });
  it("rechecks a changed routine model between credential preparation and acceptance", async () => {
    await grant(threadRecipient.key, firstRecipient.key);
    const preflight = await runAsTenant(actor, () =>
      prepareSendAiConsent(deps, actor, { botId, routineIds: [routineId] }),
    );
    await prisma.routine.update({ where: { id: routineId }, data: { modelId: "new-model" } });
    await expect(
      prisma.$transaction(preflight, { isolationLevel: "Serializable" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects a grant revoked after a Serializable admission snapshot was established", async () => {
    await grant(threadRecipient.key);
    const preflight = await runAsTenant(actor, () => prepareSendAiConsent(deps, actor, { botId }));
    let snapshotReady!: () => void;
    let proceed!: () => void;
    const ready = new Promise<void>((resolve) => {
      snapshotReady = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const transaction = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "spaces" WHERE id = ${actor.spaceId}`);
        snapshotReady();
        await resume;
        await preflight(tx);
        await tx.message.create({
          data: { threadId, seq: 999, role: "user", blocks: [] },
        });
      },
      { isolationLevel: "Serializable" },
    );
    const failure = transaction.catch((error: unknown) => error);
    await ready;
    await prisma.aiDataConsent.deleteMany({ where: { userId: actor.userId } });
    proceed();
    expect(await failure).toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "40001" } } },
    });
    expect(await prisma.message.count({ where: { threadId, seq: 999 } })).toBe(0);
    await expect(
      prisma.$transaction(preflight, { isolationLevel: "Serializable" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
