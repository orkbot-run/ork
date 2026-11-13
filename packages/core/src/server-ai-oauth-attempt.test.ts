// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcOutput } from "@orkbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { ServerAIOAuthAttempt } from "./server-ai-oauth-attempt.js";

const input = {
  provider: "anthropic",
  connectionId: null,
  label: "Team",
  models: ["model"],
  concurrencyLimit: 2,
  monthlyBudgetMicros: null,
};
const login: RpcOutput<"serverAI/beginOAuth"> = {
  loginId: "attempt",
  provider: "anthropic",
  mode: "auth-url",
  verificationUri: "https://claude.ai/authorize",
  expiresInSeconds: 600,
};
function fixture() {
  const api = {
    beginOAuth: vi.fn(async () => login),
    completeOAuth: vi.fn(async () => ({ status: "ready" as const })),
    finishOAuth: vi.fn(async () => ({ id: "account" })),
    submitOAuthCode: vi.fn(async () => ({ ok: true })),
    cancelOAuth: vi.fn(async () => ({ ok: true })),
  };
  const scope = { current: true };
  const events = {
    onState: vi.fn(),
    onError: vi.fn(),
    onSaved: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
  };
  const attempt = new ServerAIOAuthAttempt({ ...events, api, isCurrent: () => scope.current });
  return { api, scope, events, attempt };
}

describe("server AI sign-in attempt ownership", () => {
  it("submits a code to the captured installation and consumes one attempt", async () => {
    const { attempt, api, events } = fixture();
    await attempt.start(input);
    expect(events.open).toHaveBeenCalledWith(login.verificationUri);
    expect(api.beginOAuth).toHaveBeenCalledWith(
      { ...input, codePage: true },
      { signal: expect.any(AbortSignal) },
    );
    await Promise.all([attempt.submit(" code "), attempt.submit("duplicate")]);
    expect(api.submitOAuthCode).toHaveBeenCalledExactlyOnceWith(
      { loginId: login.loginId, code: "code" },
      { signal: expect.any(AbortSignal) },
    );
    expect(events.onSaved).toHaveBeenCalledExactlyOnceWith("account");
    expect(attempt.active).toBe(false);
    expect(api.cancelOAuth).not.toHaveBeenCalled();
  });
  it("cancels a delayed begin after the form is closed", async () => {
    const { attempt, api, events } = fixture();
    let resolve!: (value: RpcOutput<"serverAI/beginOAuth">) => void;
    api.beginOAuth.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const starting = attempt.start(input);
    attempt.cancel(false);
    resolve(login);
    await starting;
    expect(api.cancelOAuth).toHaveBeenCalledWith({ loginId: login.loginId });
    expect(events.open).not.toHaveBeenCalled();
    expect(events.onSaved).not.toHaveBeenCalled();
  });
  it("keeps a late completion from updating a different account or workspace", async () => {
    const { attempt, api, scope, events } = fixture();
    let resolve!: (value: { id: string }) => void;
    api.finishOAuth.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await attempt.start(input);
    const finishing = attempt.submit("code");
    await vi.waitFor(() => expect(api.finishOAuth).toHaveBeenCalled());
    scope.current = false;
    resolve({ id: "old-account" });
    await finishing;
    expect(events.onSaved).not.toHaveBeenCalled();
    expect(api.cancelOAuth).toHaveBeenCalled();
    expect(events.onError).not.toHaveBeenCalled();
  });
  it("allows correcting a rejected code without returning provider diagnostics", async () => {
    const { attempt, api, events } = fixture();
    api.submitOAuthCode.mockRejectedValueOnce(new Error("secret provider diagnostic"));
    await attempt.start(input);
    await attempt.submit("wrong");
    expect(attempt.active).toBe(true);
    expect(events.onError).toHaveBeenCalledExactlyOnceWith(
      "Could not complete AI account sign-in.",
    );
    await attempt.submit("correct");
    expect(events.onSaved).toHaveBeenCalledOnce();
  });
  it("refuses an insecure sign-in URL before opening it", async () => {
    const { attempt, api, events } = fixture();
    api.beginOAuth.mockResolvedValue({ ...login, verificationUri: "http://untrusted.test" });
    await attempt.start(input);
    expect(events.open).not.toHaveBeenCalled();
    expect(api.cancelOAuth).toHaveBeenCalled();
  });
});
