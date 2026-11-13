// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import { AIBudgetSchema, AIModelsSchema } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { z } from "zod";
import type { PiInstallationAIIntent } from "./pi-oauth.js";
import { PiOAuthLogins, serializeModelSecret } from "./pi-oauth.js";
import type { AIActor, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";

const settings = z.object({
  provider: z.string().min(1).max(100),
  connectionId: z.string().min(1).nullable(),
  label: z.string().trim().min(1).max(100),
  models: AIModelsSchema,
  concurrencyLimit: z.number().int().min(1).max(128),
  monthlyBudgetMicros: AIBudgetSchema,
  codePage: z.boolean().optional(),
});

/** The encrypted handoff and live OAuth state have a separate installation-only namespace. */
export class ServerAIOAuth {
  private readonly logins: PiOAuthLogins;
  constructor(
    private readonly deps: { prisma: PrismaClient; secrets: SecretStore; catalog: ServerAICatalog },
    logins?: PiOAuthLogins,
  ) {
    this.logins = logins ?? new PiOAuthLogins(undefined, deps, "server-ai");
  }

  private async proof(actor: AIActor) {
    if (!actor.sessionId || !actor.membershipVersion) throw new AIConnectionError("forbidden");
    return {
      ...(await this.deps.catalog.adminIdentity(actor)),
      sessionId: actor.sessionId,
      membershipVersion: actor.membershipVersion,
    };
  }

  async begin(actor: AIActor, input: z.input<typeof settings>, signal?: AbortSignal) {
    const value = settings.parse(input);
    const proof = await this.proof(actor);
    const connection = value.connectionId
      ? (await this.deps.catalog.accounts(actor)).find((row) => row.id === value.connectionId)
      : null;
    if (value.connectionId && (!connection || connection.provider !== value.provider))
      throw new AIConnectionError("invalid");
    const intent: PiInstallationAIIntent = {
      ...proof,
      connectionId: value.connectionId,
      connectionRevision: connection?.revision ?? null,
      label: value.label,
      models: value.models,
      concurrencyLimit: value.concurrencyLimit,
      monthlyBudgetMicros: value.monthlyBudgetMicros,
    };
    return this.logins.begin({
      ...actor,
      provider: value.provider,
      credentialId: value.connectionId,
      codePage: value.codePage,
      installation: intent,
      signal,
    });
  }

  private async authorize(actor: AIActor, loginId: string) {
    const proof = await this.proof(actor);
    const intent = await this.logins.installationContext(loginId, actor);
    if (
      !intent ||
      intent.accountKey !== proof.accountKey ||
      intent.bindingVersion !== proof.bindingVersion ||
      intent.membershipVersion !== proof.membershipVersion ||
      intent.sessionId !== proof.sessionId
    )
      throw new AIConnectionError("forbidden");
    return intent;
  }

  async submit(actor: AIActor, loginId: string, code: string) {
    await this.authorize(actor, loginId);
    return this.logins.submit(loginId, actor, code);
  }

  async complete(actor: AIActor, loginId: string) {
    await this.authorize(actor, loginId);
    const result = this.logins.complete(loginId, actor);
    if (result.status === "connected") return { status: "ready" as const };
    if (result.status === "error")
      return { status: "error" as const, error: "Could not complete AI account sign-in." };
    return { status: "pending" as const };
  }

  async finish(actor: AIActor, loginId: string) {
    const intent = await this.authorize(actor, loginId);
    const result = await this.logins.finish(loginId, actor, async (login) => {
      await this.authorize(actor, loginId);
      login.signal.throwIfAborted();
      const plaintext = serializeModelSecret({ kind: "oauth", credential: login.credential });
      if (intent.connectionId) {
        const current = (await this.deps.catalog.accounts(actor)).find(
          (row) => row.id === intent.connectionId,
        );
        if (
          !current ||
          current.revision !== intent.connectionRevision ||
          current.provider !== login.provider
        )
          throw new AIConnectionError("conflict");
        return this.deps.catalog.reconnect(
          actor,
          intent.connectionId,
          plaintext,
          intent.connectionRevision!,
          {
            label: intent.label,
            models: intent.models,
            concurrencyLimit: intent.concurrencyLimit,
            monthlyBudgetMicros: intent.monthlyBudgetMicros,
          },
        );
      }
      return this.deps.catalog.create(actor, {
        provider: login.provider,
        label: intent.label,
        models: intent.models,
        concurrencyLimit: intent.concurrencyLimit,
        monthlyBudgetMicros: intent.monthlyBudgetMicros,
        plaintext,
      });
    });
    if (result.status !== "connected")
      throw new AIConnectionError(result.status === "pending" ? "conflict" : "unavailable");
    return result.value;
  }

  async cancel(actor: AIActor, loginId: string) {
    await this.authorize(actor, loginId);
    await this.logins.cancel(loginId, actor);
  }

  dispose() {
    this.logins.abortAll();
  }
}
