// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunRequest, AgentRuntime, AutoReviewRequest } from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";

vi.mock("./workspace-model-policy.js", () => ({ resolveWorkspaceModel: async () => null }));
vi.mock("./model-selection.js", () => ({
  findConnectedModelCredential: async () => ({ id: "fixture", secretId: "fixture" }),
  hasHostedModelCredits: async () => false,
  UnavailableModelForAuthError: class extends Error {},
}));
vi.mock("./run-model.js", () => ({
  resolveModelKey: async (
    _deps: unknown,
    _user: unknown,
    _space: unknown,
    _credential: unknown,
    _provider: unknown,
    model: string,
  ) => ({
    apiKey: "fake",
    ...(model === "private" || model === "typesafe/jev-1.14" ? { zeroDataRetention: true } : {}),
  }),
}));

import type { AutoReviewCandidate } from "./auto-review-backups.js";
import { reviewWithBackups } from "./auto-review-backups.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { OPENROUTER_ZDR_UNAVAILABLE } from "./openrouter-zdr.js";
import { prepareAutoReviewCheckers } from "./run-auto-review.js";

const request: AutoReviewRequest = {
  toolName: "fixture",
  connectorKind: "fixture",
  args: {},
  userTask: "Fixture task",
  botDescription: "Fixture bot",
  matchingRules: [],
};
const scope = { runId: "run", spaceId: "space", userId: "user", botId: "bot", threadId: "thread" };
const context = {
  operationId: "review",
  traceId: "review",
  userId: "user",
  spaceId: "space",
  signal: new AbortController().signal,
};

async function prepare(runtime: AgentRuntime, candidates: AutoReviewCandidate[]) {
  return prepareAutoReviewCheckers(
    { runtime } as ExecutorDeps,
    scope,
    { registerSecrets: () => {} },
    candidates,
  );
}

describe("Auto-review ZDR fallback policy", () => {
  it("keeps the opted-in policy on later checkers and skips other providers", async () => {
    const run = vi.fn((input: AgentRunRequest) =>
      (async function* () {
        if (input.model.id === "private") throw new Error("Temporary checker outage");
        yield { type: "done", text: '{"decision":"pass","reason":"Fits."}' } as const;
      })(),
    );
    const candidates: AutoReviewCandidate[] = [
      { provider: "openrouter", model: "private", role: "member" },
      { provider: "anthropic", model: "other", role: "backup" },
      { provider: "openrouter", model: "backup", role: "backup" },
    ];
    const prepared = await prepare({ run } as unknown as AgentRuntime, candidates);
    const result = await reviewWithBackups(
      candidates,
      async (candidate) => (await prepared.providerFor(candidate)).review(request, context),
      context.signal,
    );
    expect(result?.decision).toBe("pass");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([input]) => input.model)).toEqual([
      expect.objectContaining({ id: "private", zeroDataRetention: true }),
      expect.objectContaining({ id: "backup", zeroDataRetention: true }),
    ]);
  });

  it.each(["endpoint", "decisions"] as const)(
    "stops after a ZDR %s rejection without advancing",
    async (failure) => {
      const run = vi.fn(() =>
        (async function* () {
          yield* [];
          throw new Error(OPENROUTER_ZDR_UNAVAILABLE);
        })(),
      );
      const candidates: AutoReviewCandidate[] = [
        {
          provider: "openrouter",
          model: failure === "decisions" ? "typesafe/jev-1.14" : "private",
          role: "member",
        },
        { provider: "openrouter", model: "backup", role: "backup" },
      ];
      const prepared = await prepare({ run } as unknown as AgentRuntime, candidates);
      const review = vi.fn(async (candidate: AutoReviewCandidate) =>
        (await prepared.providerFor(candidate)).review(request, context),
      );
      const result = await reviewWithBackups(candidates, review, context.signal);
      expect(result).toMatchObject({ decision: "error", failureCode: "model_unavailable" });
      expect(review).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledTimes(failure === "decisions" ? 0 : 1);
    },
  );
});
