// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelCredentialFailedState, SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import { withOAuthRefreshLock } from "./oauth-refresh-lock.js";
import {
  oauthCredentialAccountId,
  parseModelSecret,
  resolveModelAuth,
  serializeModelSecret,
} from "./pi-oauth.js";
import type { AIActor, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";

/** A delayed provider failure may retire only the exact material that actually failed. */
export async function retireServerAIAuth(
  deps: { prisma: PrismaClient; secrets: SecretStore; catalog: ServerAICatalog },
  actor: AIActor,
  connectionId: string,
  modelId: string,
  failed?: ModelCredentialFailedState,
): Promise<boolean> {
  if (!failed) return false;
  const retired = await deps.catalog.withAccess(actor, (signal) =>
    runAsSystem("retire the rejected installation AI credential", () =>
      withOAuthRefreshLock(deps.prisma, "server-ai-oauth-v2", connectionId, async (tx) => {
        const { account } = await deps.catalog.selection(tx, actor, connectionId, modelId);
        const current = parseModelSecret(
          await deps.secrets.load(account.secretRef, account.secretId),
        );
        signal.throwIfAborted();
        if (
          current.kind !== "oauth" ||
          current.reconnectRequired ||
          current.credential.access !== failed.access ||
          current.credential.refresh !== failed.refresh ||
          current.credential.expires !== failed.expires
        )
          return false;
        const updated = await tx.serverAIConnection.updateMany({
          where: {
            id: account.id,
            state: "active",
            revision: account.revision,
            credentialVersion: account.credentialVersion,
            secretRef: account.secretRef,
          },
          data: { state: "reconnect-required", revision: { increment: 1 } },
        });
        return updated.count === 1;
      }),
    ),
  );
  if (retired) await deps.catalog.notifyAccount(connectionId);
  return retired;
}

/** The lock follows the configured account, even when several workspaces use it concurrently. */
export async function resolveServerAIAuth(
  deps: { prisma: PrismaClient; secrets: SecretStore; catalog: ServerAICatalog },
  actor: AIActor,
  connectionId: string,
  modelId: string,
  options: {
    oauth?: Pick<OAuthAuth, "refresh" | "toAuth">;
    modify?: (current: OAuthCredential) => Promise<OAuthCredential | undefined>;
  } = {},
) {
  let retirement:
    | { id: string; revision: number; credentialVersion: number; secretRef: string }
    | undefined;
  let outcome:
    | { value: Awaited<ReturnType<typeof resolveModelAuth>>; provider: string }
    | { error: unknown };
  try {
    outcome = await deps.catalog.withAccess(actor, (signal) =>
      runAsSystem("refresh an authorized installation AI account", () =>
        withOAuthRefreshLock(deps.prisma, "server-ai-oauth-v2", connectionId, async (tx) => {
          const { account } = await deps.catalog.selection(tx, actor, connectionId, modelId);
          signal.throwIfAborted();
          let plaintext = await deps.secrets.load(account.secretRef, account.secretId);
          const persist = async (next: string) => {
            // An issued provider rotation must be saved even when its initiating request is cancelled.
            const stored = await deps.secrets.put(
              next,
              {
                ...actor,
                operationId: `ai-refresh:${account.id}`,
                traceId: `ai-refresh:${account.id}`,
                signal: AbortSignal.timeout(15_000),
              },
              { recordId: account.secretId },
            );
            const updated = await tx.serverAIConnection.updateMany({
              where: {
                id: account.id,
                state: "active",
                revision: account.revision,
                credentialVersion: account.credentialVersion,
                secretRef: account.secretRef,
              },
              data: { secretRef: stored.ref, credentialVersion: { increment: 1 } },
            });
            if (updated.count !== 1) throw new AIConnectionError("conflict");
            account.secretRef = stored.ref;
            account.credentialVersion++;
            plaintext = next;
          };
          try {
            if (options.modify) {
              const current = parseModelSecret(plaintext);
              if (current.kind !== "oauth" || current.reconnectRequired)
                throw new AIConnectionError("unavailable");
              signal.throwIfAborted();
              const next = await options.modify(current.credential);
              if (next && next.expires >= current.credential.expires) {
                const previousId = oauthCredentialAccountId(current.credential);
                const nextId = oauthCredentialAccountId(next);
                if (previousId && nextId && previousId !== nextId) {
                  retirement = {
                    id: account.id,
                    revision: account.revision,
                    credentialVersion: account.credentialVersion,
                    secretRef: account.secretRef,
                  };
                  throw new AIConnectionError("unavailable");
                }
                if (
                  next.access !== current.credential.access ||
                  next.refresh !== current.credential.refresh ||
                  next.expires !== current.credential.expires
                )
                  await persist(serializeModelSecret({ ...current, credential: next }));
              }
            }
            const value = await resolveModelAuth(plaintext, account.provider, {
              oauth: options.oauth,
              signal,
              allowRefresh: !options.modify,
              persist,
              retire: async () => {
                retirement = {
                  id: account.id,
                  revision: account.revision,
                  credentialVersion: account.credentialVersion,
                  secretRef: account.secretRef,
                };
                return true;
              },
            });
            return { value, provider: account.provider };
          } catch (error) {
            // Commit a completed rotation before reporting a formatter, revocation or provider error.
            return { error };
          }
        }),
      ),
    );
    if ("error" in outcome) throw outcome.error;
    return outcome;
  } catch (error) {
    if (retirement) {
      const expected = retirement;
      const updated = await runAsSystem(
        "retire only the exact AI credential whose refresh failed",
        () =>
          deps.prisma.serverAIConnection.updateMany({
            where: {
              id: expected.id,
              revision: expected.revision,
              credentialVersion: expected.credentialVersion,
              secretRef: expected.secretRef,
              state: "active",
            },
            data: { state: "reconnect-required", revision: { increment: 1 } },
          }),
      );
      if (updated.count) await deps.catalog.notifyAccount(expected.id);
    }
    if (error instanceof AIConnectionError) throw error;
    throw new AIConnectionError("unavailable");
  }
}
