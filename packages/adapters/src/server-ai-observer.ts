// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelCallObserver } from "@orkbot/adapter-kit";
import { canonicalPiProviderId } from "@orkbot/contracts";
import type { AIActor, AIExecutionClaim, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";

const MAX_CAPACITY_WAIT_MS = 60_000;

const micros = (usd: number | null | undefined): number | null => {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return null;
  const value = Math.ceil(usd * 1_000_000);
  return Number.isSafeInteger(value) ? value : null;
};

/** One reservation covers one provider HTTP attempt, using the existing runtime observer boundary. */
export function serverAIObserver(
  catalog: Pick<ServerAICatalog, "claim" | "heartbeat" | "cooldown" | "settle">,
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
    beforeCall: async (call, signal) => {
      if (
        call.modelId !== modelId ||
        canonicalPiProviderId(call.provider) !== canonicalPiProviderId(provider)
      )
        throw new AIConnectionError("forbidden");
      const admission = {
        operationId: `ai-call:${call.callId ?? randomUUID()}`,
        connectionId,
        modelId,
        estimatedMicros: micros(call.maxCostUsd),
        runId: call.runId,
      };
      // Capacity denials happen before a reservation or provider request exists. Keep
      // the same operation ID and let the current turn continue when a slot frees up.
      const deadline = performance.now() + MAX_CAPACITY_WAIT_MS;
      let backoff = 250;
      let claim: AIExecutionClaim;
      for (;;) {
        signal?.throwIfAborted();
        try {
          claim = await catalog.claim(scope, admission);
          break;
        } catch (error) {
          const remaining = deadline - performance.now();
          if (!(error instanceof AIConnectionError) || error.code !== "busy" || remaining <= 0)
            throw error;
          await delay(Math.min(remaining, backoff + randomInt(backoff / 2)), undefined, { signal });
          backoff = Math.min(backoff * 2, 2_000);
        }
      }
      if (signal?.aborted) {
        await catalog.settle(claim, 0);
        signal.throwIfAborted();
      }
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
