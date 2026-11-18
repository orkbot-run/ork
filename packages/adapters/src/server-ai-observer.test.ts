// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import type { AIExecutionClaim, ServerAICatalog } from "./server-ai-catalog.js";
import { AIConnectionError } from "./server-ai-catalog.js";
import { serverAIObserver } from "./server-ai-observer.js";

const scope = { userId: "user", spaceId: "space" };
const call = {
  callId: "test-call",
  provider: "openrouter",
  modelId: "model",
  inputTokensEstimate: 1,
  maxOutputTokens: 1,
};

function fixture() {
  const claim: AIExecutionClaim = {
    operationId: "ai-call:test-call",
    connectionId: "account",
    modelId: call.modelId,
    scope,
    signal: new AbortController().signal,
    dispose: vi.fn(),
  };
  const catalog = {
    claim: vi.fn(async (..._args: Parameters<ServerAICatalog["claim"]>) => claim),
    heartbeat: vi.fn(async () => {}),
    cooldown: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
  } as const;
  const observer = serverAIObserver(catalog, scope, "account", call.modelId, call.provider);
  return { catalog, observer };
}

it("waits for capacity and reserves the same call once it can run", async () => {
  const { catalog, observer } = fixture();
  catalog.claim.mockRejectedValueOnce(new AIConnectionError("busy"));

  try {
    const id = await observer.beforeCall(call);
    expect(id).toBe("ai-call:test-call");
    expect(catalog.claim.mock.calls).toHaveLength(2);
    expect(catalog.claim.mock.calls[0]).toEqual(catalog.claim.mock.calls[1]);
  } finally {
    await observer.dispose();
  }
});

it("keeps authorization and budget errors terminal", async () => {
  const { catalog, observer } = fixture();
  catalog.claim.mockRejectedValue(new AIConnectionError("budget"));

  await expect(observer.beforeCall(call)).rejects.toMatchObject({ code: "budget" });
  expect(catalog.claim).toHaveBeenCalledTimes(1);
});

it("cancels a capacity wait without making another claim", async () => {
  const { catalog, observer } = fixture();
  const controller = new AbortController();
  catalog.claim.mockRejectedValue(new AIConnectionError("busy"));

  const result = observer.beforeCall(call, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  controller.abort();

  await rejected;
  expect(catalog.claim).toHaveBeenCalledTimes(1);
  expect(catalog.settle).not.toHaveBeenCalled();
});

it("stops retrying a busy connection after the wait budget", async () => {
  const { catalog, observer } = fixture();
  catalog.claim.mockRejectedValue(new AIConnectionError("busy"));
  const clock = vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(60_001);
  try {
    await expect(observer.beforeCall(call)).rejects.toMatchObject({ code: "busy" });
    expect(catalog.claim).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
