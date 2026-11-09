// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatesStatus } from "@orkbot/contracts";
import { newClientId } from "./client-id.js";
import { errorStatus } from "./retry-policy.js";

export type ServerUpdatesView = {
  status: ServerUpdatesStatus | null;
  busy: "check" | "apply" | "policy" | null;
  error: boolean;
  uncertain: boolean;
};

export function serverUpdateCanApply(state: ServerUpdatesView, now = Date.now()): boolean {
  const status = state.status;
  const requestedAt = status?.lastRequest ? Date.parse(status.lastRequest.requestedAt) : null;
  return Boolean(
    (requestedAt === null || now - requestedAt >= 60 * 60_000) &&
      status?.available &&
      status.candidate &&
      status.candidate.revision !== status.currentRevision &&
      !state.busy &&
      !state.uncertain,
  );
}

/** Native surfaces share operation fencing; the server owns policy and deployment lifetime. */
export function createServerUpdates(client: {
  context: () => string | null;
  status: (signal: AbortSignal) => Promise<ServerUpdatesStatus>;
  check: (signal: AbortSignal) => Promise<ServerUpdatesStatus>;
  apply: (
    input: { candidateRevision: string; idempotencyKey: string },
    signal: AbortSignal,
  ) => Promise<ServerUpdatesStatus>;
  policy: (
    input: { automatic: boolean; expectedRevision: number; channel?: "stable" | "preview" },
    signal: AbortSignal,
  ) => Promise<ServerUpdatesStatus>;
  id?: () => string;
}) {
  let state: ServerUpdatesView = { status: null, busy: null, error: false, uncertain: false };
  let generation = 0;
  let revision = 0;
  let polling = false;
  let active = false;
  let blocked = false;
  let owner: string | null = null;
  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operation: { candidateRevision: string; idempotencyKey: string } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const current = (epoch: number) =>
    active && epoch === generation && owner !== null && owner === client.context();
  const refuse = () => {
    blocked = true;
    clearTimeout(timer);
    state = { status: null, busy: null, error: false, uncertain: false };
    emit();
  };
  const hidden = (error: unknown) =>
    [401, 403, 404].includes(errorStatus(error) ?? 0) ||
    (error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND");
  const accept = (status: ServerUpdatesStatus) => {
    if (!status.available) {
      refuse();
      return;
    }
    state = { status, busy: null, error: false, uncertain: false };
    if (status.lastRequest?.state === "failed") operation = null;
    emit();
  };
  const schedule = (epoch: number) => {
    clearTimeout(timer);
    if (polling && !blocked && current(epoch)) timer = setTimeout(() => void refresh(epoch), 3_000);
  };
  async function refresh(epoch: number) {
    const stamp = revision;
    try {
      if (!current(epoch) || blocked || state.busy) return;
      const status = await client.status(controller.signal);
      if (!current(epoch) || stamp !== revision) return;
      accept(status);
    } catch (error) {
      if (!current(epoch) || stamp !== revision) return;
      if (hidden(error)) refuse();
      else {
        state = { ...state, error: Boolean(state.status) };
        emit();
      }
    } finally {
      schedule(epoch);
    }
  }
  async function act(
    kind: NonNullable<ServerUpdatesView["busy"]>,
    automatic?: boolean,
    channel?: "stable" | "preview",
  ) {
    const epoch = generation;
    if (!current(epoch) || blocked || !state.status?.available || state.busy) return;
    if (kind === "apply" && !serverUpdateCanApply(state)) return;
    const status = state.status;
    revision++;
    clearTimeout(timer);
    state = { ...state, busy: kind, error: false };
    emit();
    try {
      let next: ServerUpdatesStatus;
      if (kind === "check") next = await client.check(controller.signal);
      else if (kind === "policy")
        next = await client.policy(
          {
            automatic: automatic!,
            expectedRevision: status.policyRevision,
            ...(channel ? { channel } : {}),
          },
          controller.signal,
        );
      else {
        const candidateRevision = status.candidate!.revision;
        const acknowledgedRetry =
          operation &&
          status.lastRequest?.id === operation.idempotencyKey &&
          Date.now() - Date.parse(status.lastRequest.requestedAt) >= 60 * 60_000;
        if (operation?.candidateRevision !== candidateRevision || acknowledgedRetry)
          operation = { candidateRevision, idempotencyKey: (client.id ?? newClientId)() };
        next = await client.apply(operation, controller.signal);
      }
      if (!current(epoch)) return;
      accept(next);
    } catch (error) {
      if (!current(epoch)) return;
      if (hidden(error)) refuse();
      else {
        state = {
          ...state,
          busy: null,
          error: true,
          uncertain:
            (kind === "apply" &&
              (errorStatus(error) === undefined || (errorStatus(error) ?? 0) >= 500)) ||
            state.uncertain,
        };
        emit();
      }
    } finally {
      if (current(epoch)) {
        revision++;
        schedule(epoch);
      }
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    watch(poll = true) {
      const epoch = ++generation;
      owner = client.context();
      active = true;
      blocked = false;
      polling = poll;
      controller = new AbortController();
      state = { ...state, busy: null };
      void refresh(epoch);
      return () => {
        if (epoch !== generation) return;
        active = false;
        generation++;
        controller.abort();
        clearTimeout(timer);
      };
    },
    check: () => act("check"),
    apply: () => act("apply"),
    policy: (automatic: boolean) => act("policy", automatic),
    channel: (channel: "stable" | "preview") =>
      act("policy", state.status?.mode === "automatic", channel),
  };
}
