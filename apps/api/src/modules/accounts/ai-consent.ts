// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is retained; send preflight additions follow LICENSE.md.

import { createHash } from "node:crypto";
import {
  aiRecipient,
  cloudAgentsEnabled,
  findConnectedModelCredential,
  parseModelSecret,
  resolveMemberMainModel,
  selectConfiguredModel,
  toStringRecord,
} from "@orkbot/adapters";
import type { Actor, AiConsentQuery, AiConsentStatus, AiRecipient } from "@orkbot/contracts";
import { AI_CONSENT_REQUIRED, AI_DISCLOSURE_VERSION, AI_PRIVACY_URL } from "@orkbot/contracts";
import {
  findDefaultVoiceCredential,
  findModelCredential,
  IsolationError,
  listModelRoleChoices,
  listVoicePreferences,
  modelRoleTarget,
  Prisma,
  voicePreferenceTarget,
} from "@orkbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "#modules/platform/router";
import { resolveThreadTarget } from "#modules/threads/thread-target";
import { voiceCredentialServer } from "#modules/voice/voice";

export async function aiConsentStatus(
  deps: RouterDeps,
  actor: Actor,
  query: AiConsentQuery = {},
): Promise<AiConsentStatus> {
  const uses = query.uses ?? ["model", "memory", "voice"];
  const modelsEnabled = uses.includes("model") && deps.env.agentRuntime !== "scripted";
  const target =
    query.botId || query.groupId ? await resolveThreadTarget(deps.prisma, actor, query) : null;
  const routineIds = [
    ...new Set([...(query.routineIds ?? []), ...(query.routineId ? [query.routineId] : [])]),
  ];
  // Explicit routines are authorized independently of the active chat, including paused ones.
  const requestedRoutines = routineIds.length
    ? await deps.prisma.routine.findMany({
        where: {
          id: { in: routineIds },
          userId: actor.userId,
          spaceId: actor.spaceId,
          bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
        },
        select: { id: true, botId: true, modelProvider: true, modelId: true, thinkingLevel: true },
      })
    : [];
  if (requestedRoutines.length !== routineIds.length) throw new IsolationError();
  const threadBotIds = target
    ? target.kind === "bot"
      ? [target.botId]
      : target.memberBotIds
    : undefined;
  const botIds =
    target || routineIds.length
      ? [
          ...new Set([
            ...(threadBotIds ?? []),
            ...requestedRoutines.map((routine) => routine.botId),
          ]),
        ]
      : undefined;
  const [preferences, roleChoices, main, bots, routines, voices, memory, settings, consents] =
    await Promise.all([
      modelsEnabled
        ? deps.prisma.userModelPreference.findMany({
            where: { userId: actor.userId },
            include: { credential: true },
          })
        : [],
      modelsEnabled
        ? modelRoleTarget(deps.prisma, actor).then((roles) =>
            listModelRoleChoices(deps.prisma, roles),
          )
        : [],
      modelsEnabled
        ? resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, actor)
        : null,
      modelsEnabled
        ? deps.prisma.bot.findMany({
            where: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              archivedAt: null,
              ...(botIds ? { id: { in: botIds } } : {}),
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : [],
      // Active chat routines can receive the message; explicit routines are added separately.
      modelsEnabled
        ? deps.prisma.routine.findMany({
            where: {
              userId: actor.userId,
              spaceId: actor.spaceId,
              modelProvider: { not: null },
              modelId: { not: null },
              bot: { archivedAt: null },
              ...(threadBotIds
                ? { botId: { in: threadBotIds } }
                : routineIds.length
                  ? { id: { in: [] } }
                  : {}),
              active: true,
            },
            select: { modelProvider: true, modelId: true, thinkingLevel: true },
          })
        : [],
      uses.includes("voice")
        ? query.uses
          ? findDefaultVoiceCredential(deps.prisma, actor, query.settingsScope).then(
              (credential) => (credential ? [{ credential }] : []),
            )
          : voicePreferenceTarget(deps.prisma, actor, query.settingsScope).then((target) =>
              listVoicePreferences(deps.prisma, target),
            )
        : [],
      uses.includes("memory")
        ? deps.prisma.spaceMemoryConfig.findUnique({ where: { spaceId: actor.spaceId } })
        : null,
      modelsEnabled
        ? deps.prisma.deploymentSettings.findUnique({ where: { id: "default" } })
        : null,
      deps.prisma.aiDataConsent.findMany({
        where: { userId: actor.userId, spaceId: actor.spaceId, version: AI_DISCLOSURE_VERSION },
      }),
    ]);
  const allowed = new Set(consents.map((row) => row.recipientKey));
  const recipients = new Map<string, AiRecipient>();
  const add = (recipient: ReturnType<typeof aiRecipient>) => {
    if (recipient)
      recipients.set(recipient.key, { ...recipient, allowed: allowed.has(recipient.key) });
  };
  if (modelsEnabled) {
    const deployment = deps.env.deploymentModelConfigured
      ? { provider: deps.env.defaultProvider, model: deps.env.defaultModel }
      : null;
    const selected = await Promise.all(
      (botIds ? [...bots, ...routines, ...requestedRoutines] : [null, ...bots, ...routines]).map(
        async (override) => {
          const overrideCredential =
            override?.modelProvider && override.modelId
              ? await findConnectedModelCredential(
                  deps.prisma,
                  deps.secrets,
                  actor,
                  override.modelProvider,
                  override.modelId,
                )
              : null;
          return selectConfiguredModel({
            override,
            overrideCredential,
            main,
            hostedProvider: deps.billing?.modelCreditsEnabled
              ? deps.env.defaultProvider
              : undefined,
            defaults: { settings, deployment },
          });
        },
      ),
    );
    // Connected models remain reachable by helpers during a targeted bot run.
    for (const preference of preferences)
      selected.push({
        provider: preference.credential.provider,
        id: preference.modelId ?? "",
        credential: {
          ...preference.credential,
          defaultModel: preference.modelId,
          thinkingLevel: preference.thinkingLevel,
        },
        thinkingLevel: null,
      });
    // Every purpose's models, fallbacks included, can receive a run's content.
    const roleModels = await Promise.all(
      roleChoices.map(async (choice) => {
        const credential = await findConnectedModelCredential(
          deps.prisma,
          deps.secrets,
          actor,
          choice.provider,
          choice.modelId,
          { credentialId: choice.credentialId },
        );
        return credential
          ? { provider: choice.provider, id: choice.modelId, credential, thinkingLevel: null }
          : null;
      }),
    );
    selected.push(...roleModels.filter((model) => model !== null));
    if (deps.env.teamChatJudgeProvider && deps.env.teamChatJudgeModel) {
      selected.push({
        provider: deps.env.teamChatJudgeProvider,
        id: deps.env.teamChatJudgeModel,
        credential: await findModelCredential(deps.prisma, actor, deps.env.teamChatJudgeProvider),
        thinkingLevel: null,
      });
    } else {
      // The engagement judge still resolves bot overrides by provider alone. Its connection
      // can differ from the allowlist-aware run model, so disclose both reachable endpoints.
      const judgeModels = await Promise.all(
        bots.map(async (bot) => {
          if (!bot.modelProvider || !bot.modelId) return null;
          const credential = await findModelCredential(deps.prisma, actor, bot.modelProvider);
          return credential
            ? { provider: bot.modelProvider, id: bot.modelId, credential, thinkingLevel: null }
            : null;
        }),
      );
      selected.push(...judgeModels.filter((model) => model !== null));
    }
    const models = [
      ...new Map(
        selected
          .filter((model) => model.provider)
          .map((model) => [
            JSON.stringify([model.provider, model.id, model.credential?.secretId]),
            model,
          ]),
      ).values(),
    ];
    const secrets = models.length
      ? await deps.prisma.secret.findMany({
          where: {
            userId: actor.userId,
            spaceId: null,
            id: {
              in: models.flatMap((model) => (model.credential ? [model.credential.secretId] : [])),
            },
          },
        })
      : [];
    const baseUrls = new Map(
      await Promise.all(
        secrets.map(async (secret): Promise<[string, string | undefined]> => {
          try {
            const parsed = parseModelSecret(await deps.secrets.load(secret.ciphertext, secret.id));
            return [secret.id, parsed.kind === "openai_compatible" ? parsed.baseUrl : undefined];
          } catch {
            // Unreadable credentials still disclose by provider; the base URL is unknown.
            return [secret.id, undefined];
          }
        }),
      ),
    );
    for (const model of models) {
      add(
        aiRecipient({
          provider: model.provider!,
          modelId: model.id!,
          baseUrl: model.credential ? baseUrls.get(model.credential.secretId) : undefined,
          use: "model",
        }),
      );
    }
  }
  for (const voice of voices) {
    // A self-hosted server is disclosed by its own origin, like a custom model endpoint.
    const endpoint = (await voiceCredentialServer(deps, actor, voice.credential))?.endpoint;
    add(
      aiRecipient({
        provider: voice.credential.provider,
        use: "voice",
        ...(endpoint ? { baseUrl: endpoint } : {}),
      }),
    );
  }
  if (memory)
    add(
      aiRecipient({
        provider: memory.provider,
        use: "memory",
        baseUrl: toStringRecord(memory.settings).baseUrl,
      }),
    );
  if (
    uses.includes("model") &&
    deps.cloudAgent &&
    cloudAgentsEnabled(deps.cloudAgent, actor.spaceId) &&
    !deps.cloudAgent.provider.describe().capabilities.offline
  ) {
    add(aiRecipient({ provider: deps.cloudAgent.provider.describe().id, use: "model" }));
  }
  return {
    scope: createHash("sha256")
      .update(JSON.stringify([actor.userId, actor.spaceId]))
      .digest("hex"),
    version: AI_DISCLOSURE_VERSION,
    privacyUrl: deps.env.privacyPolicyUrl ?? AI_PRIVACY_URL,
    recipients: [...recipients.values()],
  };
}

export async function allowAiConsent(
  deps: RouterDeps,
  actor: Actor,
  input: { scope: string; version: string; keys: string[] } & AiConsentQuery,
) {
  // Checked against the same settings copy the member reviewed.
  const current = await aiConsentStatus(deps, actor, input);
  const known = new Set(current.recipients.map((recipient) => recipient.key));
  if (
    input.scope !== current.scope ||
    input.version !== current.version ||
    input.keys.some((key) => !known.has(key))
  ) {
    throw new ORPCError("CONFLICT", { message: "AI data sharing changed. Review it again." });
  }
  // Interactive rather than a batch: a batch cannot carry the request's database context.
  await deps.prisma.$transaction(async (tx) => {
    for (const recipientKey of input.keys)
      await tx.aiDataConsent.upsert({
        where: {
          userId_spaceId_recipientKey: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            recipientKey,
          },
        },
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey,
          version: current.version,
        },
        update: { version: current.version, grantedAt: new Date() },
      });
  });
  return {
    ...current,
    recipients: current.recipients.map((recipient) =>
      input.keys.includes(recipient.key) ? { ...recipient, allowed: true } : recipient,
    ),
  };
}

/** Resolve remote credential material before admission, then recheck the accepted DB snapshot. */
export async function prepareSendAiConsent(deps: RouterDeps, actor: Actor, query: AiConsentQuery) {
  // This cache belongs only to this request, including its transaction retries.
  const secrets = new Map<string, Promise<string>>();
  const keyOf = (ref: string, context: Parameters<RouterDeps["secrets"]["load"]>[1]) =>
    JSON.stringify([ref, context]);
  const prepared = {
    ...deps,
    secrets: {
      ...deps.secrets,
      load: (ref: string, context: Parameters<RouterDeps["secrets"]["load"]>[1]) => {
        const key = keyOf(ref, context);
        let value = secrets.get(key);
        if (!value) {
          value = deps.secrets.load(ref, context);
          secrets.set(key, value);
        }
        return value;
      },
    },
  };
  const target = { ...query, uses: ["model", "memory"] as const };
  const assertAllowed = (status: AiConsentStatus) => {
    if (status.recipients.some((recipient) => !recipient.allowed)) {
      throw new ORPCError("FORBIDDEN", { message: AI_CONSENT_REQUIRED });
    }
  };
  await aiConsentStatus(prepared, actor, { ...target, uses: [...target.uses] });
  return async (tx: Prisma.TransactionClient) => {
    let changed = false;
    const status = await aiConsentStatus(
      {
        ...prepared,
        prisma: tx as RouterDeps["prisma"],
        secrets: {
          ...prepared.secrets,
          load: (ref, context) => {
            const value = secrets.get(keyOf(ref, context));
            if (value) return value;
            changed = true;
            return Promise.reject(new Error("AI connection changed during send admission"));
          },
        },
      },
      actor,
      { ...target, uses: [...target.uses] },
    );
    if (changed)
      throw new ORPCError("CONFLICT", { message: "AI data sharing changed. Review it again." });
    assertAllowed(status);
    if (status.recipients.length) {
      // A grant revoked while admission waited cannot survive a stale Serializable snapshot.
      // SHARE also keeps the exact reviewed grants valid until this acceptance commits.
      const grants = await tx.$queryRaw<Array<{ recipientKey: string }>>(Prisma.sql`
        SELECT "recipientKey" FROM "ai_data_consents"
        WHERE "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
          AND "version" = ${status.version}
          AND "recipientKey" IN (${Prisma.join(status.recipients.map((recipient) => recipient.key))})
        ORDER BY "recipientKey" FOR SHARE
      `);
      if (grants.length !== status.recipients.length)
        throw new ORPCError("FORBIDDEN", { message: AI_CONSENT_REQUIRED });
    }
  };
}
