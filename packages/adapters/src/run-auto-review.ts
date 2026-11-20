// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors for coordinated OAuth refreshes. See LICENSE.md.

import type { AgentRuntimeEvent, AutoReviewProvider } from "@orkbot/adapter-kit";
import { DecisionProviderError } from "@orkbot/adapter-kit";
import type { ModelRoleChoice } from "@orkbot/contracts";
import { recordUsage } from "@orkbot/db";
import {
  autoReviewTimeoutMs,
  isAutoReviewCheckerConfigured,
  resolveAutoReviewChecker,
} from "./auto-review.js";
import type { AutoReviewCandidate } from "./auto-review-backups.js";
import { createAutoReviewProvider } from "./auto-review-factory.js";
import {
  AutoReviewConnectionUnavailableError,
  AutoReviewProviderConstructionError,
  logAutoReviewFailure,
} from "./auto-review-failures.js";
import { DecisionAutoReviewProvider } from "./decision-auto-review.js";
import { decisionModel } from "./decision-models.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { HttpDecisionProvider } from "./http-decisions.js";
import type { EffectiveModelRole } from "./model-roles.js";
import { findConnectedModelCredential, hasHostedModelCredits } from "./model-selection.js";
import { resolveModelKey } from "./run-model.js";
import { resolveWorkspaceModel } from "./workspace-model-policy.js";

export function selectAutoReviewCandidates(
  settings: EffectiveModelRole | null,
  injected: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AutoReviewCandidate[] {
  if (injected) return [{ provider: "injected", model: "injected", role: "default" }];
  const saved = (choice: ModelRoleChoice, role: "member" | "backup"): AutoReviewCandidate => ({
    provider: choice.provider,
    model: choice.modelId,
    thinkingLevel: choice.thinkingLevel,
    credentialId: choice.credentialId,
    role,
  });
  const candidates = [
    ...(settings?.primarySource === "member" && settings.primary
      ? [saved(settings.primary, "member")]
      : []),
    ...(settings?.backups.map((choice) => saved(choice, "backup")) ?? []),
  ];
  try {
    const checker = resolveAutoReviewChecker(env);
    if (!checker) return candidates;
    const configured = isAutoReviewCheckerConfigured({ env });
    // With no explicit choice, retain the legacy ability to use a member's key
    // for the deployment's model. A last-resort checker needs its own instance key.
    if (configured || candidates.length === 0) {
      candidates.push({
        ...checker,
        role: "default",
        ...(configured ? { instance: true } : {}),
        ...(candidates.length > 0 ? { fallback: true } : {}),
      });
    }
  } catch {
    logAutoReviewFailure(
      {
        provider: "unavailable",
        model: "unavailable",
        role: "default",
        fallback: candidates.length > 0,
      },
      "provider_construction",
    );
  }
  return candidates;
}

/** An organization-owned model is resolved once and owns the entire review. */
export async function prepareAutoReviewCheckers(
  deps: ExecutorDeps,
  scope: { runId: string; spaceId: string; userId: string; botId: string; threadId: string },
  options: {
    injectedReview?: AutoReviewProvider;
    registerSecrets: (values: string[]) => void;
  },
  candidates: readonly AutoReviewCandidate[],
) {
  const { runId, spaceId, userId, botId, threadId } = scope;
  const { injectedReview, registerSecrets } = options;
  const onUsage = (event: Extract<AgentRuntimeEvent, { type: "usage" }>) =>
    recordUsage(deps.prisma, event, {
      spaceId,
      userId,
      botId,
      parentRunId: runId,
      runId,
      operationId: `auto-review:${runId}`,
      operationKind: "setup",
    });
  const workspace = await resolveWorkspaceModel(deps, spaceId, scope);
  if (workspace) {
    registerSecrets(workspace.redact);
    const model = workspace.model;
    const checker: AutoReviewCandidate = {
      provider: model.provider,
      model: model.id,
      thinkingLevel: model.thinkingLevel,
      role: "default",
    };
    const provider = createAutoReviewProvider("llm", {
      llm: {
        runtime: deps.runtime,
        checker,
        apiKey: model.apiKey,
        routing: model.routing,
        accountId: model.accountId,
        gatewayId: model.gatewayId,
        baseUrl: model.baseUrl,
        apiProtocol: model.apiProtocol,
        headers: model.headers,
        allowPrivateEndpoint: model.allowPrivateEndpoint,
        cacheCapabilities: model.cacheCapabilities,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        oauth: model.oauth,
        callObserver: model.callObserver,
        runId,
        spaceId,
        userId,
        botId,
        threadId,
        onUsage,
      },
    });
    return { candidates: [checker], providerFor: async () => provider };
  }
  const personalModels = await deps.serverAIModels?.personalModelsAllowed(scope);
  if (personalModels === false) throw new AutoReviewConnectionUnavailableError();
  const eligible =
    personalModels === true ? candidates.filter((checker) => !checker.instance) : candidates;
  if (eligible.length === 0) throw new AutoReviewConnectionUnavailableError();
  const providerFor = async (checker: AutoReviewCandidate): Promise<AutoReviewProvider> => {
    if (injectedReview) return injectedReview;
    if (checker.instance && (checker.provider === "jev" || checker.provider === "scripted")) {
      try {
        return createAutoReviewProvider(checker.provider, { model: checker.model });
      } catch (error) {
        throw new AutoReviewProviderConstructionError("Unable to configure the checker", {
          cause: error,
        });
      }
    }
    const reviewCredential = checker.instance
      ? null
      : await findConnectedModelCredential(
          deps.prisma,
          deps.secretStore,
          { userId, spaceId },
          checker.provider,
          checker.model,
          { credentialId: checker.credentialId },
        );
    if (
      !reviewCredential &&
      (checker.credentialId ||
        (checker.role !== "default" &&
          !(await hasHostedModelCredits(deps.prisma, { userId, spaceId }, checker.provider))))
    )
      throw new AutoReviewConnectionUnavailableError();
    const judgeKey = await resolveModelKey(
      deps,
      userId,
      spaceId,
      reviewCredential,
      checker.provider,
      checker.model,
      registerSecrets,
      {
        requireStoredSecret: Boolean(checker.credentialId || reviewCredential),
        deploymentApiKey:
          checker.instance && checker.provider === "anthropic"
            ? process.env.ANTHROPIC_API_KEY?.trim()
            : undefined,
      },
    );
    try {
      return decisionModel(checker.provider, checker.model)
        ? new DecisionAutoReviewProvider({
            provider: new HttpDecisionProvider("openrouter", {
              apiKey: judgeKey.apiKey ?? "",
              callObserver: judgeKey.callObserver,
              onUsage,
            }),
            providerId: checker.provider,
            model: checker.model,
          })
        : createAutoReviewProvider("llm", {
            llm: {
              onUsage,
              runtime: deps.runtime,
              checker,
              apiKey: judgeKey.oauth ? undefined : judgeKey.apiKey,
              routing: judgeKey.routing,
              callObserver: judgeKey.callObserver,
              accountId: judgeKey.accountId,
              gatewayId: judgeKey.gatewayId,
              baseUrl: judgeKey.baseUrl,
              apiProtocol: judgeKey.apiProtocol,
              headers: judgeKey.headers,
              allowPrivateEndpoint: judgeKey.allowPrivateEndpoint,
              cacheCapabilities: judgeKey.cacheCapabilities,
              contextWindow: judgeKey.contextWindow,
              maxTokens: judgeKey.maxTokens,
              reasoning: judgeKey.reasoning,
              oauth: judgeKey.oauth
                ? {
                    credential: judgeKey.oauth,
                    persist: judgeKey.persistOAuth,
                    refresh: judgeKey.refreshOAuth,
                    retire: judgeKey.retireOAuth,
                  }
                : undefined,
              runId,
              spaceId,
              userId,
              botId,
              threadId,
              timeoutMs: autoReviewTimeoutMs(),
            },
          });
    } catch (error) {
      if (error instanceof DecisionProviderError) throw error;
      throw new AutoReviewProviderConstructionError("Unable to configure the checker", {
        cause: error,
      });
    }
  };
  return { candidates: [...eligible], providerFor };
}
