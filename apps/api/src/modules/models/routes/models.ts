// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 routes are preserved; metadata-based preset routing follows LICENSE.md.

import { SecretStoreUnavailableError } from "@orkbot/adapter-kit";
import {
  findWorkspaceModelPolicy,
  listPiCatalog,
  ModelSignInError,
  modelConnectionMetadata,
  modelCredentialDto,
  oauthCredentialEmail,
  prepareStoredModelAuth,
  probeCatalogProviderModels,
  probeOpenAiCompatibleModels,
  providerCatalogCache,
  resolveMemberMainModel,
  selectDefaultCredentialId,
  serializeModelSecret,
  storedOpenAiCompatibleProbeHeaders,
  storedOpenAiCompatibleProbeKey,
  UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
} from "@orkbot/adapters";
import type { ThinkingLevel } from "@orkbot/contracts";
import {
  backupChoiceKey,
  canonicalPiProviderId,
  compatibleEndpointPreset,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  usableModelId,
} from "@orkbot/contracts";
import { clampCatalogThinkingLevel, redactSecrets } from "@orkbot/core";
import type { PrismaClient } from "@orkbot/db";
import {
  appliedModelRole,
  comparePreferenceOrder,
  defaultModelCredentialCandidates,
  deleteUnreferencedCredentialSecret,
  findModelCredential,
  getModelRole,
  modelCredentialProviderFilter,
  modelRoleTarget,
  newestModelCredentialOrder,
  Prisma,
  runAsSystemInTransaction,
  saveModelPreference,
  updateModelRole,
  writeModelRole,
} from "@orkbot/db";
import { ORPCError } from "@orpc/server";
import { mayUsePrivateEndpoint } from "#modules/mcp/mcp-servers";
import type { RouterContext } from "#modules/platform/routes/context";
import { withSerializableRetry } from "#modules/platform/serializable-retry";
import { installationCredentials } from "../installation-catalog.js";
import { firstModelConnectAnalytics } from "../model-connect-analytics.js";
import {
  modelConnectionTarget,
  persistModelCredential,
  prepareAllowedThinkingLevels,
  throwIfAborted,
} from "../model-credentials.js";
import { assertCompatibleDefaultChange } from "../model-pins.js";

export function modelsRoutes(ctx: RouterContext) {
  const {
    deps,
    codexCatalog,
    connectModelCredential,
    refreshExpiredCredential,
    chatCatalog,
    withDeploymentDefault,
    modelRoleCatalog,
    validateRoleChoices,
    authed,
  } = ctx;
  const workspace = async (actor: { userId: string; spaceId: string }) => {
    const space = await deps.prisma.space.findUniqueOrThrow({
      where: { id: actor.spaceId },
      select: {
        organizationId: true,
        organization: {
          select: { members: { where: { userId: actor.userId }, select: { role: true } } },
        },
      },
    });
    return {
      organizationId: space.organizationId,
      owner: space.organization.members.some(({ role }) =>
        role.split(",").some((part) => part.trim() === "owner"),
      ),
    };
  };
  const requireUnmanagedWorkspace = async (actor: { userId: string; spaceId: string }) => {
    if (await deps.serverAIModels?.actor(actor))
      throw new ORPCError("FORBIDDEN", { message: "Manage AI connections on this server." });
  };
  const requirePersonalModelsAllowed = async (actor: { userId: string; spaceId: string }) => {
    await requireUnmanagedWorkspace(actor);
    if (await findWorkspaceModelPolicy(deps.prisma, actor.spaceId))
      throw new ORPCError("FORBIDDEN", { message: "Models are managed by the workspace owner." });
  };
  return {
    models: {
      workspacePolicy: authed.models.workspacePolicy.handler(async ({ context }) => {
        const managed = await deps.serverAIModels?.actor(context.actor);
        if (managed && deps.serverAI) {
          const choices = await deps.serverAI.choices(managed);
          const primary = choices[0];
          const connection =
            primary &&
            (await deps.serverAI.list(managed)).find((row) => row.id === primary.connectionId);
          return {
            managed: true,
            canManage: false,
            policy:
              connection && primary
                ? { provider: connection.provider, modelId: primary.modelId }
                : null,
          };
        }
        const { organizationId, owner } = await workspace(context.actor);
        const policy = await deps.prisma.workspaceModelPolicy.findUnique({
          where: { organizationId },
          select: { provider: true, modelId: true },
        });
        return { canManage: owner, policy };
      }),
      setWorkspacePolicy: authed.models.setWorkspacePolicy.handler(async ({ context, input }) => {
        if (await deps.serverAIModels?.actor(context.actor))
          throw new ORPCError("FORBIDDEN", { message: "Manage AI connections on this server." });
        const { organizationId, owner } = await workspace(context.actor);
        if (!owner) throw new ORPCError("FORBIDDEN");
        if (!input.apiKey?.trim() || !input.modelId?.trim())
          throw new ORPCError("BAD_REQUEST", {
            message: "A model and a new API key are required.",
          });
        // Always create a new connection: never read or reuse a member's personal key.
        let plaintext: string;
        try {
          ({ plaintext } = await ctx.verifyModelConnection(
            context.actor,
            { ...input, credentialId: null },
            context.signal,
          ));
        } catch {
          // Provider responses can echo request headers or keys; never forward them.
          throw new ORPCError("BAD_REQUEST", {
            message: "Could not verify the model connection. Check its settings and API key.",
          });
        }
        let stored: Awaited<ReturnType<typeof deps.secrets.put>>;
        try {
          stored = await deps.secrets.put(plaintext, {
            operationId: "workspace-model",
            traceId: "workspace-model",
            ...context.actor,
            signal: context.signal ?? new AbortController().signal,
          });
        } catch {
          throw new ORPCError("SERVICE_UNAVAILABLE", {
            message: "Could not securely save the workspace model.",
          });
        }
        let previous: { secretId: string; secretRef: string } | null;
        try {
          previous = await withSerializableRetry(() =>
            deps.prisma.$transaction(
              async (tx) => {
                const old = await tx.workspaceModelPolicy.findUnique({
                  where: { organizationId },
                  select: { secretId: true, secretRef: true },
                });
                const data = {
                  provider: input.provider,
                  modelId: input.modelId!.trim(),
                  secretId: stored.id,
                  secretRef: stored.ref,
                };
                await tx.workspaceModelPolicy.upsert({
                  where: { organizationId },
                  create: { organizationId, ...data },
                  update: data,
                });
                return old;
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            ),
          );
        } catch (error) {
          await deps.secrets.delete(stored.ref, stored.id).catch(() => undefined);
          throw error;
        }
        if (previous)
          await deps.secrets.delete(previous.secretRef, previous.secretId).catch(() => undefined);
        return { ok: true as const };
      }),
      clearWorkspacePolicy: authed.models.clearWorkspacePolicy.handler(async ({ context }) => {
        if (await deps.serverAIModels?.actor(context.actor))
          throw new ORPCError("FORBIDDEN", { message: "Manage AI connections on this server." });
        const { organizationId, owner } = await workspace(context.actor);
        if (!owner) throw new ORPCError("FORBIDDEN");
        const previous = await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const old = await tx.workspaceModelPolicy.findUnique({
                where: { organizationId },
                select: { secretId: true, secretRef: true },
              });
              const removed = await tx.workspaceModelPolicy.deleteMany({
                where: { organizationId },
              });
              if (old && removed.count !== 1) throw new ORPCError("FORBIDDEN");
              return old;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        if (previous)
          await deps.secrets.delete(previous.secretRef, previous.secretId).catch(() => undefined);
        return { ok: true as const };
      }),
      list: authed.models.list.handler(async ({ context }) => chatCatalog(context.actor)),
      credentials: authed.models.credentials.handler(async ({ context }) => {
        const managed = await installationCredentials(deps, context.actor);
        if (managed) return managed;
        const [rows, main] = await Promise.all([
          deps.prisma.userModelCredential.findMany({
            where: { userId: context.actor.userId },
            include: { userPreferences: { where: { userId: context.actor.userId } } },
            orderBy: newestModelCredentialOrder,
          }),
          resolveMemberMainModel({ prisma: deps.prisma, secretStore: deps.secrets }, context.actor),
        ]);
        const secrets = rows.length
          ? await deps.prisma.secret.findMany({
              where: {
                id: { in: rows.map((row) => row.secretId) },
                userId: context.actor.userId,
                spaceId: null,
              },
              select: { id: true, ciphertext: true },
            })
          : [];
        const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
        const preferenceRanks = new Map(
          rows
            .flatMap((row) => row.userPreferences)
            .sort(comparePreferenceOrder)
            .map((preference, index) => [preference.credentialId, index]),
        );
        return Promise.all(
          rows.map(async ({ userPreferences, ...row }) => {
            const preference = userPreferences[0];
            const own = {
              ...row,
              defaultModel: preference?.modelId ?? null,
              thinkingLevel: preference?.thinkingLevel ?? null,
            };
            const runsMain = main?.credential && main.credential.id === row.id;
            const dto = (plaintext?: string) => {
              const listed = modelCredentialDto(own, plaintext);
              // The connection running the main model shows that model, as apps read it,
              // while its own model stays enabled.
              const shown = runsMain
                ? modelCredentialDto(
                    {
                      ...row,
                      isDefault: true,
                      defaultModel: main.modelId,
                      thinkingLevel: main.thinkingLevel ?? null,
                    },
                    plaintext,
                  )
                : listed;
              return {
                ...shown,
                ...(shown.enabledModelIds
                  ? {
                      enabledModelIds: [
                        ...new Set([...shown.enabledModelIds, ...(listed.enabledModelIds ?? [])]),
                      ],
                    }
                  : {}),
                ...(preference
                  ? { preferenceRank: preferenceRanks.get(preference.credentialId) }
                  : {}),
              };
            };
            const ciphertext = ciphertextById.get(row.secretId);
            if (!ciphertext) return dto();
            try {
              return dto(await deps.secrets.load(ciphertext, row.secretId));
            } catch (error) {
              if (error instanceof SecretStoreUnavailableError)
                throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
              return dto();
            }
          }),
        );
      }),
      forRole: authed.models.forRole.handler(async ({ context, input }) =>
        modelRoleCatalog(context.actor, input.role),
      ),
      role: authed.models.role.handler(async ({ context, input }) => {
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        return withDeploymentDefault(
          input.role,
          await getModelRole(
            deps.prisma,
            await modelRoleTarget(deps.prisma, context.actor, input.scope),
            input.role,
          ),
        );
      }),
      setRole: authed.models.setRole.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        if (input.expectedUserId && input.expectedUserId !== context.actor.userId)
          throw new ORPCError("FORBIDDEN");
        const { role, primary, backups, scope } = input;
        await validateRoleChoices(context.actor, role, [
          ...(primary ? [primary] : []),
          ...(backups ?? []),
        ]);
        return withDeploymentDefault(
          role,
          await updateModelRole(
            deps.prisma,
            { userId: context.actor.userId, spaceId: context.actor.spaceId, scope },
            role,
            { primary, backups },
          ),
        );
      }),
      backups: authed.models.backups.handler(async ({ context }) =>
        (await appliedModelRole(deps.prisma, context.actor, "main")).backups.map(
          ({ provider, modelId }) => ({ provider, modelId }),
        ),
      ),
      setBackups: authed.models.setBackups.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        await validateRoleChoices(context.actor, "main", input);
        await updateModelRole(
          deps.prisma,
          { userId: context.actor.userId, spaceId: context.actor.spaceId },
          "main",
          { backups: input },
        );
        return { ok: true as const };
      }),
      connect: authed.models.connect.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        const record = await firstModelConnectAnalytics(deps, context.actor, "api_key");
        record(input.provider, { name: "model_connect_started" });
        try {
          const saved = await connectModelCredential(context.actor, input, context.signal);
          record(input.provider, { name: "model_connected" });
          return saved;
        } catch (error) {
          record(input.provider, { name: "model_connect_failed", error });
          throw error;
        }
      }),
      probeOpenAiCompatible: authed.models.probeOpenAiCompatible.handler(
        async ({ context, input }) => {
          await requireUnmanagedWorkspace(context.actor);
          let apiKey = input.apiKey;
          let headers = input.headers;
          if (!apiKey?.trim() || headers === undefined) {
            try {
              const preferred = await findModelCredential(
                deps.prisma,
                context.actor,
                OPENAI_COMPATIBLE_PROVIDER_ID,
              );
              const credentials = await deps.prisma.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
              });
              const candidates = input.credentialId
                ? credentials.filter((credential) => credential.id === input.credentialId)
                : preferred
                  ? [
                      preferred,
                      ...credentials.filter((credential) => credential.id !== preferred.id),
                    ]
                  : credentials;
              const secrets = await deps.prisma.secret.findMany({
                where: {
                  id: { in: candidates.map((credential) => credential.secretId) },
                  userId: context.actor.userId,
                  spaceId: null,
                },
                select: { id: true, ciphertext: true },
              });
              const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
              for (const credential of candidates) {
                const ciphertext = ciphertexts.get(credential.secretId);
                if (!ciphertext) continue;
                try {
                  const plaintext = await deps.secrets.load(ciphertext, credential.secretId);
                  const savedKey = storedOpenAiCompatibleProbeKey(input.baseUrl, plaintext);
                  const savedHeaders = storedOpenAiCompatibleProbeHeaders(input.baseUrl, plaintext);
                  if (!savedKey && savedHeaders === undefined) continue;
                  // A saved key and its routing headers are one credential. Explicit
                  // replacements may override either field, but never borrow from another row.
                  if (!apiKey?.trim()) apiKey = savedKey;
                  headers ??= savedHeaders;
                  break;
                } catch {
                  // An unreadable secret must not prevent trying the remaining credentials.
                }
              }
            } catch {
              // An unavailable saved key must not prevent a keyless probe.
            }
          }
          try {
            const models = await probeOpenAiCompatibleModels(
              { ...input, apiKey, headers },
              compatibleEndpointPreset(
                normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
                modelConnectionMetadata(OPENAI_COMPATIBLE_PROVIDER_ID)?.presets,
              )
                ? deps.modelConnectionFetch
                : undefined,
              context.signal,
              { allowPrivate: mayUsePrivateEndpoint(deps) },
            );
            const secretValues = [apiKey, apiKey?.trim(), ...Object.values(headers ?? {})].filter(
              (value): value is string => Boolean(value),
            );
            return {
              models: models.filter(
                (model) => !secretValues.some((value) => model.includes(value)),
              ),
            };
          } catch (error) {
            const secretValues = [apiKey, apiKey?.trim(), ...Object.values(headers ?? {})].filter(
              (value): value is string => Boolean(value),
            );
            throw new ORPCError("BAD_REQUEST", {
              message:
                error instanceof Error
                  ? redactSecrets(error.message, secretValues)
                  : "Could not list models",
            });
          }
        },
      ),
      probeCatalog: authed.models.probeCatalog.handler(async ({ context, input }) => {
        await requireUnmanagedWorkspace(context.actor);
        try {
          const models = await probeCatalogProviderModels(
            { provider: input.provider, apiKey: input.apiKey },
            deps.modelConnectionFetch,
            context.signal,
          );
          return { models: models.filter((model) => !model.includes(input.apiKey)) };
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              error instanceof Error
                ? redactSecrets(error.message, [input.apiKey])
                : "Could not list models",
          });
        }
      }),
      beginOAuth: authed.models.beginOAuth.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        // An older app's sign-in renews the provider's newest connection, bound now so a
        // disconnect of that connection retires it and it never lands on another one.
        const target = await modelConnectionTarget(
          deps,
          context.actor,
          input.provider,
          input.credentialId,
        );
        const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
        record(input.provider, { name: "model_connect_started" });
        return deps.oauthLogins
          .begin({
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            provider: input.provider,
            credentialId: target?.id ?? null,
            modelId: input.modelId,
            thinkingLevel: input.thinkingLevel,
            makeDefault: input.makeDefault,
            settingsScope: input.scope,
            label: input.label,
            codePage: input.codePage,
            signal: context.signal,
          })
          .catch((error: unknown) => {
            record(input.provider, { name: "model_connect_failed", error });
            throw error;
          });
      }),
      submitOAuthCode: authed.models.submitOAuthCode.handler(async ({ context, input }) => {
        await requireUnmanagedWorkspace(context.actor);
        return deps.oauthLogins
          .submit(input.loginId, context.actor, input.code)
          .catch((error: unknown) => {
            if (error instanceof ModelSignInError)
              throw new ORPCError("BAD_REQUEST", { message: error.message, cause: error });
            throw error;
          });
      }),
      completeOAuth: authed.models.completeOAuth.handler(async ({ context, input }) => {
        await requireUnmanagedWorkspace(context.actor);
        const result = await deps.oauthLogins.complete(input.loginId, {
          userId: context.actor.userId,
          spaceId: context.actor.spaceId,
        });
        if (result.status === "error") {
          const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
          record(result.provider, { name: "model_connect_failed", error: new Error(result.error) });
          return { status: "error" as const, error: result.error };
        }
        return result.status === "connected" ? { status: "ready" as const } : result;
      }),
      finishOAuth: authed.models.finishOAuth.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        throwIfAborted(context.signal);
        let provider: string | undefined;
        const record = await firstModelConnectAnalytics(deps, context.actor, "oauth");
        const result = await deps.oauthLogins
          .finish(input.loginId, context.actor, async (login) => {
            provider = login.provider;
            const target = await modelConnectionTarget(
              deps,
              context.actor,
              login.provider,
              login.credentialId,
            );
            return persistModelCredential(
              deps,
              context.actor,
              {
                provider: login.provider,
                credentialId: target?.id ?? null,
                plaintext: serializeModelSecret({ kind: "oauth", credential: login.credential }),
                // A second account is told apart by the email it signed in with.
                label:
                  oauthCredentialEmail(login.credential) ??
                  login.label ??
                  listPiCatalog().find((entry) => entry.provider === login.provider)?.providerName,
                modelId: login.modelId,
                thinkingLevel: login.thinkingLevel,
                makeDefault: login.makeDefault,
                scope: login.settingsScope,
                signal: login.signal,
              },
              codexCatalog,
            );
          })
          .catch((error: unknown) => {
            record(provider, { name: "model_connect_failed", error });
            throw error;
          });
        if (result.status === "pending") {
          throw new ORPCError("CONFLICT", { message: "Sign-in has not finished yet." });
        }
        if (result.status === "error") {
          record(provider, { name: "model_connect_failed", error: new Error(result.error) });
          throw new ORPCError("NOT_FOUND", { message: result.error });
        }
        record(provider, { name: "model_connected" });
        return result.value;
      }),
      cancelOAuth: authed.models.cancelOAuth.handler(async ({ context, input }) => {
        await deps.oauthLogins.cancel(input.loginId, context.actor);
        return { ok: true as const };
      }),
      setDefault: authed.models.setDefault.handler(async ({ context, input }) => {
        await requirePersonalModelsAllowed(context.actor);
        const modelId = usableModelId(input.modelId);
        if (!modelId) throw new ORPCError("BAD_REQUEST", { message: "Choose a model" });
        // An omitted level keeps the one this model already has in the main list: on the
        // chosen connection first, then on another, as writeModelRole does.
        const savedChoices = async (
          client: Pick<
            PrismaClient,
            "spaceModelRoleChoice" | "userModelRoleChoice" | "spaceSettingOverride"
          >,
        ) => {
          const main = await appliedModelRole(client, context.actor, "main");
          const key = backupChoiceKey({ provider: input.provider, modelId });
          return [...(main.primary ? [main.primary] : []), ...main.backups].filter(
            (choice) => backupChoiceKey(choice) === key,
          );
        };
        const loadModelState = async (
          client: Pick<PrismaClient, "userModelPreference" | "userModelCredential">,
        ) => {
          const [preferences, credentials] = await Promise.all([
            client.userModelPreference.findMany({
              where: {
                userId: context.actor.userId,
                credential: { provider: modelCredentialProviderFilter(input.provider) },
              },
              include: { credential: true },
            }),
            client.userModelCredential.findMany({
              where: {
                userId: context.actor.userId,
                provider: modelCredentialProviderFilter(input.provider),
              },
            }),
          ]);
          return {
            preferences,
            candidates: defaultModelCredentialCandidates({
              provider: input.provider,
              modelId: input.modelId,
              preferences,
              credentials,
            }),
          };
        };
        await withSerializableRetry(async () => {
          const preparedState = await loadModelState(deps.prisma);
          const preparedAuth = new Map(
            await Promise.all(
              preparedState.candidates.map(
                async (candidate) =>
                  [
                    candidate.secretId,
                    await prepareStoredModelAuth(
                      deps.prisma,
                      deps.secrets,
                      context.actor.userId,
                      candidate.secretId,
                      input.provider,
                      input.modelId,
                      codexCatalog,
                      {
                        onExpiredToken: () =>
                          refreshExpiredCredential(
                            context.actor,
                            candidate.secretId,
                            input.provider,
                          ),
                      },
                    ),
                  ] as const,
              ),
            ),
          );
          const needsThinking =
            input.thinkingLevel === undefined
              ? (await savedChoices(deps.prisma)).some((choice) => Boolean(choice.thinkingLevel))
              : Boolean(input.thinkingLevel);
          const compatible = input.provider === OPENAI_COMPATIBLE_PROVIDER_ID;
          // Compatible defaults always load the secret so the transaction rechecks it.
          const thinking =
            needsThinking || compatible
              ? await prepareAllowedThinkingLevels(
                  deps,
                  context.actor,
                  input.provider,
                  input.modelId,
                )
              : { allowed: undefined, secret: undefined };
          if (compatible) {
            await assertCompatibleDefaultChange(deps, context.actor, modelId, thinking);
          }
          return deps.prisma.$transaction(
            async (tx) => {
              const { preferences, candidates } = await loadModelState(tx);
              if (candidates.length === 0) {
                throw new ORPCError("NOT_FOUND", {
                  message: `No model credential is connected for ${input.provider}.`,
                });
              }
              if (thinking.secret) {
                const current = await tx.secret.findFirst({
                  where: { id: thinking.secret.id, userId: context.actor.userId, spaceId: null },
                  select: { ciphertext: true },
                });
                if (current?.ciphertext !== thinking.secret.ciphertext) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
              }
              const savedModelId = new Map(
                preferences.map((preference) => [preference.credential.id, preference.modelId]),
              );
              const readyIds: string[] = [];
              let authFailure: string | undefined;
              let sawReadable = false;
              for (const candidate of candidates) {
                const prepared = preparedAuth.get(candidate.secretId);
                const current = await tx.secret.findFirst({
                  where: { id: candidate.secretId, userId: context.actor.userId, spaceId: null },
                  select: { id: true, ciphertext: true },
                });
                if (!prepared || (current?.ciphertext ?? null) !== prepared.ref) {
                  throw new ORPCError("CONFLICT", { message: "Model credentials changed; retry." });
                }
                const auth = prepared.auth;
                if (auth.status === "unreadable") continue;
                sawReadable = true;
                if (auth.status === "rejected") {
                  authFailure ??= auth.message;
                  continue;
                }
                // The enabled-list check and execution must use the same connection.
                if (compatible && thinking.secret && candidate.secretId !== thinking.secret.id)
                  continue;
                readyIds.push(candidate.id);
              }
              const chosenId = selectDefaultCredentialId({
                provider: input.provider,
                modelId: input.modelId,
                orderedIds: candidates.map((candidate) => candidate.id),
                readyIds,
                savedModelId: (credentialId) => savedModelId.get(credentialId),
              });
              const fallbackId = !sawReadable ? candidates[0]?.id : undefined;
              const credentialId = chosenId ?? fallbackId;
              if (!credentialId) {
                throw new ORPCError("BAD_REQUEST", {
                  message: authFailure ?? UNAVAILABLE_MODEL_FOR_AUTH_MESSAGE,
                });
              }
              const saved = input.thinkingLevel === undefined ? await savedChoices(tx) : [];
              let thinkingLevel: string | null =
                input.thinkingLevel === undefined
                  ? ((saved.find((choice) => choice.credentialId === credentialId) ?? saved[0])
                      ?.thinkingLevel ?? null)
                  : input.thinkingLevel;
              if (thinkingLevel) {
                if (!needsThinking) {
                  throw new ORPCError("CONFLICT", { message: "Model preferences changed; retry." });
                }
                thinkingLevel = clampCatalogThinkingLevel(thinkingLevel, thinking.allowed);
              }
              await writeModelRole(tx, await modelRoleTarget(tx, context.actor), "main", {
                primary: {
                  provider: input.provider,
                  modelId,
                  thinkingLevel: thinkingLevel as ThinkingLevel | null,
                  credentialId,
                },
              });
              // Older apps edit one model per connection here, so it becomes the connection's own.
              await saveModelPreference(tx, context.actor, credentialId, modelId, thinkingLevel);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        }).catch((error: unknown) => {
          if (error instanceof SecretStoreUnavailableError)
            throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
          throw error;
        });
        return { ok: true as const };
      }),
      rename: authed.models.rename.handler(async ({ context, input }) => {
        await requireUnmanagedWorkspace(context.actor);
        const renamed = await deps.prisma.userModelCredential.updateMany({
          where: { id: input.credentialId, userId: context.actor.userId },
          data: { label: input.label },
        });
        if (renamed.count === 0)
          throw new ORPCError("NOT_FOUND", { message: "Connection not found" });
        return { ok: true as const };
      }),
      disconnect: authed.models.disconnect.handler(async ({ context, input }) => {
        await requireUnmanagedWorkspace(context.actor);
        // Retire pending sign-ins in every space first — the credentials are
        // account-wide, so a finishing OAuth session anywhere could otherwise
        // re-persist a credential the delete below just removed. Removing one
        // connection leaves sign-ins that add another account running.
        await deps.oauthLogins.cancelProvider({
          userId: context.actor.userId,
          provider: input.provider,
          credentialId: input.credentialId,
        });
        await withSerializableRetry(() =>
          deps.prisma.$transaction(
            async (tx) => {
              const provider = modelCredentialProviderFilter(input.provider);
              const connections = await tx.userModelCredential.findMany({
                where: { userId: context.actor.userId, provider },
              });
              // Older apps disconnect every connection of the provider.
              const existing = input.credentialId
                ? connections.filter((row) => row.id === input.credentialId)
                : connections;
              if (input.credentialId && existing.length === 0) return;
              const ids = existing.map((row) => row.id);
              const lastConnection = existing.length === connections.length;
              const roleRows = {
                userId: context.actor.userId,
                provider,
                OR: [
                  { credentialId: { in: ids } },
                  // Rows that name no connection ran on the provider's last one.
                  ...(lastConnection ? [{ credentialId: null }] : []),
                ],
              };
              // Its models leave every purpose in the account's models and every Space's,
              // like the connection itself; the tenant scope would otherwise limit the
              // Space deletes to the active Space.
              await tx.userModelRoleChoice.deleteMany({ where: roleRows });
              await runAsSystemInTransaction(
                tx,
                "disconnect a model connection from every Space",
                async () => {
                  await tx.spaceModelRoleChoice.deleteMany({ where: roleRows });
                },
              );
              if (existing.length === 0) return;
              // Credentials are account-wide, so disconnecting removes them from every Space.
              await tx.userModelCredential.deleteMany({
                where: { userId: context.actor.userId, id: { in: ids } },
              });
              for (const row of existing) {
                await deleteUnreferencedCredentialSecret(tx, {
                  credentialKind: "model",
                  credentialId: row.id,
                  secretId: row.secretId,
                });
              }
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          ),
        );
        (deps.providerCatalog ?? providerCatalogCache).invalidate(
          canonicalPiProviderId(input.provider),
        );
        return { ok: true as const };
      }),
    },
  };
}
