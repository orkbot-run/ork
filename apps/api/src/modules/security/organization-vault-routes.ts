// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { OrganizationVault, organizationVaultPolicy } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { BotSecretAuth } from "@orkbot/contracts";
import { recordSecurityEvent } from "@orkbot/db";
import { ORPCError } from "@orpc/server";
import { requireIdentityConfirmation } from "#modules/accounts/identity-confirmation";
import type { RouterContext } from "#modules/platform/routes/context";

export function organizationVaultRoutes({ deps, authed }: RouterContext) {
  const vault = new OrganizationVault(deps.prisma, deps.secrets);
  const actorOf = async (actor: Actor) => {
    const scoped = await deps.serverAIModels?.actor(actor);
    if (!scoped) throw new ORPCError("FORBIDDEN");
    return scoped;
  };
  const guarded = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      if (error instanceof Error && error.message === "Organization vault access denied")
        throw new ORPCError("FORBIDDEN");
      throw error;
    }
  };
  return {
    organizationVault: {
      credentialWorkspaces: authed.organizationVault.credentialWorkspaces.handler(
        ({ context, input }) =>
          guarded(async () => vault.workspaces(await actorOf(context.actor), input.name)),
      ),
      setCredentialWorkspaceAccess: authed.organizationVault.setCredentialWorkspaceAccess.handler(
        ({ context, input }) =>
          guarded(async () => {
            await vault.setWorkspaceAccess(
              await actorOf(context.actor),
              input.name,
              input.spaceId,
              input.allowed,
            );
            return { ok: true as const };
          }),
      ),
      context: authed.organizationVault.context.handler(({ context }) =>
        guarded(async () => {
          const policy = await organizationVaultPolicy(deps.prisma, context.actor);
          return { kind: policy.kind };
        }),
      ),
      list: authed.organizationVault.list.handler(({ context }) =>
        guarded(async () => {
          const rows = await vault.list(await actorOf(context.actor));
          return rows.map((row) => ({
            ...row,
            auth: BotSecretAuth.safeParse(row.auth).data ?? null,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }));
        }),
      ),
      reveal: authed.organizationVault.reveal.handler(({ context, input }) =>
        guarded(async () => {
          await requireIdentityConfirmation(deps.auth, context);
          const revealed = await vault.reveal(await actorOf(context.actor), input.name);
          if (!revealed) throw new ORPCError("NOT_FOUND");
          await recordSecurityEvent({
            type: "credential.revealed",
            userId: context.actor.userId,
            spaceId: context.actor.spaceId,
            metadata: {
              procedure: "organizationVault.reveal",
              kind: "organization_vault",
              name: input.name,
            },
          });
          return revealed;
        }),
      ),
      // Older clients cannot express per-secret access; refuse their global controls.
      workspaces: authed.organizationVault.workspaces.handler(() => {
        throw new ORPCError("NOT_IMPLEMENTED");
      }),
      setWorkspaceAccess: authed.organizationVault.setWorkspaceAccess.handler(() => {
        throw new ORPCError("NOT_IMPLEMENTED");
      }),
      put: authed.organizationVault.put.handler(({ context, input }) =>
        guarded(async () => {
          const actor = await actorOf(context.actor);
          if (input.value === undefined) {
            if (input.createOnly) throw new ORPCError("BAD_REQUEST");
            await vault.relabel(actor, input);
          } else
            await vault.put(actor, {
              destination: input.destination,
              plaintext: input.value,
              title: input.title,
              note: input.note,
              createOnly: input.createOnly,
            });
          return { ok: true as const };
        }),
      ),
      remove: authed.organizationVault.remove.handler(({ context, input }) =>
        guarded(async () => {
          await vault.remove(await actorOf(context.actor), input.name);
          return { ok: true as const };
        }),
      ),
    },
  };
}
