// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AgentRunRequest } from "@orkbot/adapter-kit";
import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";

it("uses the workspace model even when an approval has a different personal checker", async () => {
  let request: AgentRunRequest | undefined;
  const prisma = {
    workspaceModelPolicy: {
      findFirst: vi.fn().mockResolvedValue({
        provider: "openrouter",
        modelId: "company-model",
        secretId: "key-id",
        secretRef: "encrypted",
      }),
    },
  };
  const runtime = {
    run: vi.fn(async function* (value: AgentRunRequest) {
      request = value;
      yield { type: "done" as const, text: '{"decision":"pass"}' };
    }),
  };
  const deps = {
    prisma,
    runtime,
    secretStore: { load: vi.fn().mockResolvedValue("workspace-test-key") },
  } as unknown as ExecutorDeps;
  const registerSecrets = vi.fn();
  const scope = {
    runId: "run",
    spaceId: "space",
    userId: "member",
    botId: "bot",
    threadId: "thread",
  };
  const checker = await autoReviewCheckerProvider(
    deps,
    scope,
    { memberChecker: true, registerSecrets },
    { provider: "personal-provider", model: "personal-model" },
  );
  const result = await checker.review(
    {
      toolName: "read",
      connectorKind: "test",
      args: {},
      userTask: "test",
      botDescription: "test",
      matchingRules: [],
    },
    { ...scope, operationId: "op", traceId: "trace", signal: new AbortController().signal },
  );
  expect(result.decision).toBe("pass");
  expect(request?.model).toMatchObject({
    provider: "openrouter",
    id: "company-model",
    apiKey: "workspace-test-key",
  });
  expect(registerSecrets).toHaveBeenCalledWith(expect.arrayContaining(["workspace-test-key"]));
});
