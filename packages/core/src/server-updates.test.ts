// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatesStatus } from "@orkbot/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServerUpdates, serverUpdateCanApply } from "./server-updates.js";

const base: ServerUpdatesStatus = {
  available: true,
  mode: "manual",
  channel: "preview",
  currentRevision: "a".repeat(40),
  candidate: { revision: "b".repeat(40), version: "0.2.0" },
  lastCheckedAt: null,
  policyRevision: 2,
  lastRequest: null,
  error: null,
};
const id = "00000000-0000-4000-8000-000000000001";
let context: string | null;
const client = () => ({
  context: () => context,
  id: () => id,
  status: vi.fn().mockResolvedValue(base),
  check: vi.fn().mockResolvedValue(base),
  apply: vi.fn().mockResolvedValue({
    ...base,
    lastRequest: {
      id,
      revision: base.candidate!.revision,
      state: "requested",
      requestedAt: new Date().toISOString(),
    },
  }),
  policy: vi.fn().mockResolvedValue({ ...base, mode: "automatic", policyRevision: 3 }),
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  context = "server-a:account-a:session-a";
});
afterEach(() => vi.useRealTimers());

it("keeps unsupported deployments hidden and refuses all mutations", async () => {
  const api = client();
  api.status.mockResolvedValue({ ...base, available: false });
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  await updates.check();
  await updates.apply();
  await updates.policy(true);
  expect(updates.getSnapshot().status).toBeNull();
  expect(api.check).not.toHaveBeenCalled();
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.policy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.status).toHaveBeenCalledOnce();
  stop();
});

it("uses an immutable candidate, a fresh UUID and revision-checked policy", async () => {
  const api = client();
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  await updates.check();
  await updates.policy(true);
  await updates.apply();
  expect(api.policy).toHaveBeenCalledWith(
    { automatic: true, expectedRevision: 2 },
    expect.any(AbortSignal),
  );
  expect(api.apply).toHaveBeenCalledWith(
    { candidateRevision: base.candidate!.revision, idempotencyKey: id },
    expect.any(AbortSignal),
  );
  expect(updates.getSnapshot().status?.lastRequest?.state).toBe("requested");
  expect(updates.getSnapshot().status?.currentRevision).toBe(base.currentRevision);
  await updates.apply();
  expect(api.apply).toHaveBeenCalledOnce();
  stop();
});

it("does not let an older status overwrite a policy mutation", async () => {
  const api = client();
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  let finish!: (status: ServerUpdatesStatus) => void;
  api.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(3_000);
  await updates.policy(true);
  finish(base);
  await flush();
  expect(updates.getSnapshot().status?.mode).toBe("automatic");
  stop();
});

it.each([401, 403, 404])("hides controls and stops polling after refusal %s", async (status) => {
  const api = client();
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  api.check.mockRejectedValue(Object.assign(new Error("refused"), { status }));
  await updates.check();
  expect(updates.getSnapshot().status).toBeNull();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.status).toHaveBeenCalledOnce();
  stop();
});

it("ignores responses and refuses actions after a server or account session switch", async () => {
  const api = client();
  let finish!: (status: ServerUpdatesStatus) => void;
  api.status.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  context = "server-b:account-b:session-b";
  finish(base);
  await flush();
  await updates.apply();
  await updates.policy(true);
  expect(updates.getSnapshot().status).toBeNull();
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.policy).not.toHaveBeenCalled();
  stop();
});

it("reconnects after a temporary restart without claiming deployment completion", async () => {
  const api = client();
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  await updates.apply();
  api.status.mockRejectedValueOnce(new TypeError("offline"));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(updates.getSnapshot().error).toBe(true);
  api.status.mockResolvedValue({
    ...base,
    currentRevision: base.candidate!.revision,
    candidate: null,
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(updates.getSnapshot().error).toBe(false);
  expect(updates.getSnapshot().status?.currentRevision).toBe(base.candidate!.revision);
  stop();
});

it("reuses an uncertain request key after authoritative reconciliation", async () => {
  const api = client();
  api.apply.mockRejectedValueOnce(new TypeError("lost ACK"));
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  await updates.apply();
  expect(updates.getSnapshot().uncertain).toBe(true);
  expect(serverUpdateCanApply(updates.getSnapshot())).toBe(false);
  await vi.advanceTimersByTimeAsync(3_000);
  await updates.apply();
  expect(api.apply.mock.calls.map(([input]) => input)).toEqual([
    { candidateRevision: base.candidate!.revision, idempotencyKey: id },
    { candidateRevision: base.candidate!.revision, idempotencyKey: id },
  ]);
  stop();
});

it.each(["submitting", "requested", "unknown", "failed"] as const)(
  "honors the deployment cooldown across candidates (%s)",
  (state) => {
    const status = {
      ...base,
      lastRequest: { id, revision: "c".repeat(40), state, requestedAt: new Date().toISOString() },
    };
    const view = { status, busy: null, error: false, uncertain: false };
    expect(serverUpdateCanApply(view)).toBe(false);
    expect(serverUpdateCanApply(view, Date.now() + 60 * 60_000)).toBe(true);
  },
);

it("stops all polling and ignores an in-flight mutation on unmount", async () => {
  const api = client();
  const updates = createServerUpdates(api);
  const stop = updates.watch();
  await flush();
  let finish!: (status: ServerUpdatesStatus) => void;
  api.policy.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = updates.policy(true);
  stop();
  finish({ ...base, mode: "automatic" });
  await saving;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.status).toHaveBeenCalledOnce();
  expect(updates.getSnapshot().status?.mode).toBe("manual");
});

it.each(["unknown", "requested", "failed"] as const)(
  "uses a new UUID for an explicit same-candidate retry after cooldown (%s)",
  async (state) => {
    const api = client();
    const nextId = "00000000-0000-4000-8000-000000000002";
    api.id = vi.fn().mockReturnValueOnce(id).mockReturnValue(nextId);
    const request = {
      id,
      revision: base.candidate!.revision,
      state,
      requestedAt: new Date().toISOString(),
    };
    api.apply.mockResolvedValueOnce({ ...base, lastRequest: request });
    api.check.mockResolvedValue({ ...base, lastRequest: request });
    const updates = createServerUpdates(api);
    const stop = updates.watch(false);
    await flush();
    await updates.apply();
    await updates.apply();
    expect(api.apply).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    await updates.check();
    await updates.apply();
    expect(api.apply.mock.calls[1]![0]).toEqual({
      candidateRevision: base.candidate!.revision,
      idempotencyKey: nextId,
    });
    stop();
  },
);
