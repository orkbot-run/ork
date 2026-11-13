// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AIActor } from "@orkbot/adapters";
import { AIConnectionError, listPiCatalog } from "@orkbot/adapters";
import type { Actor, ModelConnectInput } from "@orkbot/contracts";
import { canonicalPiProviderId } from "@orkbot/contracts";
import { ORPCError } from "@orpc/server";
import type { RouterContext } from "#modules/platform/routes/context";

export function serverAIRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const actorOf = async (context: { actor: Actor; sessionId?: string }): Promise<AIActor> => {
    const actor = await deps.serverAIModels?.actor(context.actor);
    if (!actor || !deps.serverAI) throw new ORPCError("FORBIDDEN");
    return { ...actor, sessionId: context.sessionId };
  };
  const safe = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      if (error instanceof AIConnectionError) {
        const code = (
          {
            forbidden: "FORBIDDEN",
            invalid: "BAD_REQUEST",
            conflict: "CONFLICT",
            budget: "FORBIDDEN",
            busy: "TOO_MANY_REQUESTS",
            unavailable: "SERVICE_UNAVAILABLE",
          } as const
        )[error.code];
        throw new ORPCError(code, { message: error.message });
      }
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: "AI connection unavailable" });
    }
  };
  const prepare = async (
    context: { actor: Actor; sessionId?: string; signal?: AbortSignal },
    input: ModelConnectInput,
  ) => {
    const actor = await actorOf(context);
    if (!(await deps.serverAI!.permissions(actor)).canManageServer)
      throw new ORPCError("FORBIDDEN");
    try {
      const result = await ctx.verifyModelConnection(
        context.actor,
        { ...input, credentialId: null, makeDefault: false },
        context.signal,
      );
      return { actor, plaintext: result.plaintext };
    } catch {
      throw new ORPCError("BAD_REQUEST", { message: "Could not verify the AI connection." });
    }
  };
  return {
    serverAI: {
      beginOAuth: authed.serverAI.beginOAuth.handler(({ context, input }) =>
        safe(async () => {
          if (!deps.serverAIOAuth) throw new ORPCError("FORBIDDEN");
          return deps.serverAIOAuth.begin(await actorOf(context), input, context.signal);
        }),
      ),
      submitOAuthCode: authed.serverAI.submitOAuthCode.handler(({ context, input }) =>
        safe(async () => {
          if (!deps.serverAIOAuth) throw new ORPCError("FORBIDDEN");
          return deps.serverAIOAuth.submit(await actorOf(context), input.loginId, input.code);
        }),
      ),
      completeOAuth: authed.serverAI.completeOAuth.handler(({ context, input }) =>
        safe(async () => {
          if (!deps.serverAIOAuth) throw new ORPCError("FORBIDDEN");
          return deps.serverAIOAuth.complete(await actorOf(context), input.loginId);
        }),
      ),
      finishOAuth: authed.serverAI.finishOAuth.handler(({ context, input }) =>
        safe(async () => {
          if (!deps.serverAIOAuth) throw new ORPCError("FORBIDDEN");
          return deps.serverAIOAuth.finish(await actorOf(context), input.loginId);
        }),
      ),
      cancelOAuth: authed.serverAI.cancelOAuth.handler(({ context, input }) =>
        safe(async () => {
          if (!deps.serverAIOAuth) throw new ORPCError("FORBIDDEN");
          await deps.serverAIOAuth.cancel(await actorOf(context), input.loginId);
          return { ok: true as const };
        }),
      ),
      catalog: authed.serverAI.catalog.handler(({ context }) =>
        safe(async () => {
          const actor = await actorOf(context);
          if (!(await deps.serverAI!.permissions(actor)).canManageServer)
            throw new ORPCError("FORBIDDEN");
          return listPiCatalog();
        }),
      ),
      status: authed.serverAI.status.handler(({ context }) =>
        safe(async () => {
          const actor = await deps.serverAIModels?.actor(context.actor);
          if (!actor || !deps.serverAI)
            return {
              spaceId: context.actor.spaceId,
              available: false,
              workspaceMonthlyBudgetMicros: null,
              canManageServer: false,
              canManageWorkspace: false,
              accounts: [],
              connections: [],
            };
          const scoped = { ...actor, sessionId: context.sessionId };
          const permissions = await deps.serverAI.permissions(scoped);
          return {
            spaceId: context.actor.spaceId,
            available: true,
            workspaceMonthlyBudgetMicros: await deps.serverAI.workspaceBudget(scoped),
            ...permissions,
            connections: await deps.serverAI.list(scoped),
            accounts: permissions.canManageServer ? await deps.serverAI.accounts(scoped) : [],
          };
        }),
      ),
      create: authed.serverAI.create.handler(({ context, input }) =>
        safe(async () => {
          const { actor, plaintext } = await prepare(context, input.connection);
          const { connection, ...settings } = input;
          return deps.serverAI!.create(actor, {
            ...settings,
            provider: canonicalPiProviderId(connection.provider),
            plaintext,
          });
        }),
      ),
      reconnect: authed.serverAI.reconnect.handler(({ context, input }) =>
        safe(async () => {
          const { actor, plaintext } = await prepare(context, input.connection);
          const account = (await deps.serverAI!.accounts(actor)).find(
            (row) => row.id === input.connectionId,
          );
          if (!account || account.provider !== canonicalPiProviderId(input.connection.provider))
            throw new ORPCError("BAD_REQUEST");
          return deps.serverAI!.reconnect(actor, input.connectionId, plaintext);
        }),
      ),
      update: authed.serverAI.update.handler(({ context, input }) =>
        safe(async () => {
          const { connectionId, ...settings } = input;
          return deps.serverAI!.update(await actorOf(context), connectionId, settings);
        }),
      ),
      offer: authed.serverAI.offer.handler(({ context, input }) =>
        safe(async () => {
          await deps.serverAI!.offer(
            await actorOf(context),
            input.spaceId,
            input.connectionId,
            input.available,
          );
          return { ok: true as const };
        }),
      ),
      configure: authed.serverAI.configure.handler(({ context, input }) =>
        safe(async () => {
          const { connectionId, ...settings } = input;
          await deps.serverAI!.configure(await actorOf(context), connectionId, settings);
          return { ok: true as const };
        }),
      ),
      workspaceBudget: authed.serverAI.workspaceBudget.handler(({ context, input }) =>
        safe(async () => {
          await deps.serverAI!.setWorkspaceBudget(
            await actorOf(context),
            input.monthlyBudgetMicros,
          );
          return { ok: true as const };
        }),
      ),
      disable: authed.serverAI.disable.handler(({ context, input }) =>
        safe(async () => {
          await deps.serverAI!.disable(await actorOf(context), input.connectionId);
          return { ok: true as const };
        }),
      ),
    },
  };
}
