// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { ModelCallObserver } from "@orkbot/adapter-kit";
import { canonicalPiProviderId } from "@orkbot/contracts";
import type { AIActor, AIExecutionClaim, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";

const micros = (usd: number | null | undefined): number | null => {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return null;
  const value = Math.ceil(usd * 1_000_000);
  return Number.isSafeInteger(value) ? value : null;
};

/** One reservation covers one provider HTTP attempt, using the existing runtime observer boundary. */
export function serverAIObserver(
  catalog: ServerAICatalog,
  scope: AIActor,
  connectionId: string,
  modelId: string,
  provider: string,
): ModelCallObserver & { dispose(): Promise<void> } {
  const held = new Map<
    string,
    { claim: AIExecutionClaim; timer: ReturnType<typeof setInterval> }
  >();
  return {
    beforeCall: async (call) => {
      if (
        call.modelId !== modelId ||
        canonicalPiProviderId(call.provider) !== canonicalPiProviderId(provider)
      )
        throw new AIConnectionError("forbidden");
      const claim = await catalog.claim(scope, {
        operationId: `ai-call:${call.callId ?? randomUUID()}`,
        connectionId,
        modelId,
        estimatedMicros: micros(call.maxCostUsd),
        runId: call.runId,
      });
      let renewing = false;
      const timer = setInterval(() => {
        if (renewing || claim.signal.aborted) return;
        renewing = true;
        void catalog
          .heartbeat(claim)
          .catch(() => undefined)
          .finally(() => {
            renewing = false;
          });
      }, 10_000);
      timer.unref?.();
      held.set(claim.operationId, { claim, timer });
      return claim.operationId;
    },
    signalForCall: (id) => held.get(id)?.claim.signal,
    onResponse: async (id, response) => {
      const current = held.get(id);
      if (current && response.status === 429)
        await catalog.cooldown(current.claim, response.retryAfter);
    },
    afterCall: async (id, usage) => {
      const current = held.get(id);
      if (!current) return;
      held.delete(id);
      clearInterval(current.timer);
      await catalog.settle(current.claim, micros(usage?.costUsd));
    },
    dispose: async () => {
      const remaining = [...held.values()];
      held.clear();
      await Promise.all(
        remaining.map(async (item) => {
          clearInterval(item.timer);
          await catalog.settle(item.claim, null);
        }),
      );
    },
  };
}
