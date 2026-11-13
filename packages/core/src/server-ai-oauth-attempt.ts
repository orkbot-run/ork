// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcInput, RpcOutput } from "@orkbot/contracts";
import { waitForModelOAuthCompletion } from "./model-oauth.js";

type Options = { signal?: AbortSignal };
export type ServerAIOAuthAPI = {
  beginOAuth(
    input: RpcInput<"serverAI/beginOAuth">,
    options?: Options,
  ): Promise<RpcOutput<"serverAI/beginOAuth">>;
  completeOAuth(
    input: { loginId: string },
    options?: Options,
  ): Promise<RpcOutput<"serverAI/completeOAuth">>;
  finishOAuth(input: { loginId: string }, options?: Options): Promise<{ id: string }>;
  submitOAuthCode(input: { loginId: string; code: string }, options?: Options): Promise<unknown>;
  cancelOAuth(input: { loginId: string }, options?: Options): Promise<unknown>;
};
type Attempt = {
  controller: AbortController;
  login?: RpcOutput<"serverAI/beginOAuth">;
  submitting: boolean;
};

/** Native and web forms share attempt ownership, cancellation and polling. */
export class ServerAIOAuthAttempt {
  private attempt: Attempt | null = null;
  get active(): boolean {
    return this.attempt !== null;
  }
  constructor(
    private readonly deps: {
      api: ServerAIOAuthAPI;
      isCurrent(): boolean;
      open(url: string): Promise<void>;
      onState(login: RpcOutput<"serverAI/beginOAuth"> | null, pending: boolean): void;
      onError(
        message: "Could not complete AI account sign-in." | "Connected, but could not refresh.",
      ): void;
      onSaved(id: string): Promise<unknown>;
    },
  ) {}

  private current(attempt: Attempt) {
    return this.attempt === attempt && !attempt.controller.signal.aborted && this.deps.isCurrent();
  }
  private retire(attempt: Attempt) {
    attempt.controller.abort();
    if (attempt.login)
      void this.deps.api.cancelOAuth({ loginId: attempt.login.loginId }).catch(() => undefined);
    if (this.attempt === attempt) this.attempt = null;
  }
  cancel(publish = true) {
    if (this.attempt) this.retire(this.attempt);
    if (publish && this.deps.isCurrent()) this.deps.onState(null, false);
  }
  private fail(attempt: Attempt) {
    const publish = this.current(attempt);
    this.retire(attempt);
    if (publish) {
      this.deps.onState(null, false);
      this.deps.onError("Could not complete AI account sign-in.");
    }
  }
  private async finish(attempt: Attempt) {
    const { signal } = attempt.controller;
    const loginId = attempt.login!.loginId;
    await waitForModelOAuthCompletion(
      () => {
        if (!this.current(attempt)) {
          this.retire(attempt);
          signal.throwIfAborted();
        }
        return this.deps.api.completeOAuth({ loginId }, { signal });
      },
      { signal },
    );
    if (!this.current(attempt)) {
      this.retire(attempt);
      return;
    }
    const saved = await this.deps.api.finishOAuth({ loginId }, { signal });
    if (!this.current(attempt)) {
      this.retire(attempt);
      return;
    }
    this.attempt = null;
    this.deps.onState(null, false);
    try {
      await this.deps.onSaved(saved.id);
    } catch {
      if (this.deps.isCurrent()) this.deps.onError("Connected, but could not refresh.");
    }
  }
  async start(input: RpcInput<"serverAI/beginOAuth">) {
    if (this.attempt || !this.deps.isCurrent()) return;
    const attempt: Attempt = { controller: new AbortController(), submitting: false };
    this.attempt = attempt;
    this.deps.onState(null, true);
    try {
      attempt.login = await this.deps.api.beginOAuth(
        { ...input, codePage: true },
        { signal: attempt.controller.signal },
      );
      if (!this.current(attempt)) {
        this.retire(attempt);
        return;
      }
      if (new URL(attempt.login.verificationUri).protocol !== "https:")
        throw new Error("Invalid sign-in URL");
      this.deps.onState(attempt.login, true);
      await this.deps.open(attempt.login.verificationUri);
      if (!this.current(attempt)) {
        this.retire(attempt);
        return;
      }
      if (attempt.login.mode !== "auth-url") await this.finish(attempt);
    } catch {
      this.fail(attempt);
    }
  }
  async submit(code: string) {
    const attempt = this.attempt;
    if (
      !attempt ||
      !this.current(attempt) ||
      attempt.login?.mode !== "auth-url" ||
      attempt.submitting ||
      !code.trim()
    )
      return;
    attempt.submitting = true;
    let submitted = false;
    try {
      await this.deps.api.submitOAuthCode(
        { loginId: attempt.login.loginId, code: code.trim() },
        { signal: attempt.controller.signal },
      );
      submitted = true;
      if (!this.current(attempt)) {
        this.retire(attempt);
        return;
      }
      await this.finish(attempt);
    } catch {
      if (!submitted && this.current(attempt))
        this.deps.onError("Could not complete AI account sign-in.");
      else this.fail(attempt);
    } finally {
      attempt.submitting = false;
    }
  }
}
