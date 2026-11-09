// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ServerUpdatesStatus } from "@orkbot/contracts";
import { expect, it } from "vitest";
import { serverUpdateProgressPhase } from "./server-updates.js";

const status: ServerUpdatesStatus = {
  available: true,
  mode: "manual",
  channel: "stable",
  currentRevision: "a".repeat(40),
  candidate: { revision: "b".repeat(40), version: "v1.2.3" },
  lastCheckedAt: null,
  policyRevision: 0,
  lastRequest: {
    id: "00000000-0000-4000-8000-000000000001",
    revision: "b".repeat(40),
    state: "requested",
    requestedAt: "2026-11-09T00:00:00.000Z",
  },
  error: null,
};
const view = { status, busy: null, error: false, uncertain: false } as const;

it("waits for status when the server only acknowledges the request", () => {
  expect(serverUpdateProgressPhase(view)).toBe("waiting");
});

it("preserves the updater's reported phase for the acknowledged operation", () => {
  expect(
    serverUpdateProgressPhase({
      ...view,
      status: { ...status, lastRequest: { ...status.lastRequest!, phase: "downloading" } },
    }),
  ).toBe("downloading");
});

it("shows reconnecting during a temporary API interruption and resumes the reported phase", () => {
  expect(serverUpdateProgressPhase({ ...view, error: true })).toBe("reconnecting");
  expect(serverUpdateProgressPhase(view)).toBe("waiting");
});

it.each(["completed", "failed", "unknown"] as const)(
  "stops progress for %s operations",
  (state) => {
    expect(
      serverUpdateProgressPhase({
        ...view,
        status: { ...status, lastRequest: { ...status.lastRequest!, state, phase: "restarting" } },
      }),
    ).toBeNull();
  },
);

it("distinguishes checking from preparing an update without claiming a download", () => {
  const idle = { ...view, status: { ...status, lastRequest: null } };
  expect(serverUpdateProgressPhase(idle)).toBeNull();
  expect(serverUpdateProgressPhase({ ...idle, busy: "check" })).toBe("checking");
  expect(serverUpdateProgressPhase({ ...idle, busy: "apply" })).toBe("preparing");
  expect(
    serverUpdateProgressPhase({
      ...view,
      status: { ...status, lastRequest: { ...status.lastRequest!, state: "submitting" } },
    }),
  ).toBe("preparing");
});

it("retains the active deployment phase while checking for releases", () => {
  expect(serverUpdateProgressPhase({ ...view, busy: "check" })).toBe("waiting");
});

it("preserves an uncertain request warning instead of showing an older operation's phase", () => {
  expect(serverUpdateProgressPhase({ ...view, error: true, uncertain: true })).toBeNull();
});
