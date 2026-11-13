// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceProjection } from "@orkbot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAuthorityWindow } from "./workspace-authority-window.js";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const revision = "20000000-0000-4000-8000-000000000001";
const projection = (
  members = [{ userId: "participant", role: "member" as const, accessVersion: revision }],
  version = 1,
): WorkspaceProjection => ({
  serverId: "30000000-0000-4000-8000-000000000001",
  organizationId: "40000000-0000-4000-8000-000000000001",
  bindingVersion: 1,
  keyFingerprint: "a".repeat(64),
  verifiedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  workspaces: [
    {
      id: workspaceId,
      name: "Workspace",
      operationId: workspaceId,
      state: "ready",
      localOrganizationId: "local-org",
      localWorkspaceId: "local-space",
      permissionVersion: version,
      members,
    },
  ],
});

describe("workspace authority window", () => {
  let authority: WorkspaceAuthorityWindow;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
    authority = new WorkspaceAuthorityWindow();
  });
  afterEach(() => {
    authority.dispose();
    vi.useRealTimers();
  });
  it("expires requests and running streams within 300 seconds measured from request start", () => {
    const start = performance.now();
    vi.advanceTimersByTime(5_000);
    authority.apply(projection(), start);
    const stream = authority.watch(workspaceId, "participant", revision);
    vi.advanceTimersByTime(294_999);
    expect(authority.permits(workspaceId, "participant", revision)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
    expect(stream.signal.aborted).toBe(true);
  });
  it("does not extend authority when the wall clock moves backwards", () => {
    authority.apply(projection(), performance.now());
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    vi.advanceTimersByTime(300_000);
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
  });
  it("aborts known revocation immediately and rejects an old admission after re-add", () => {
    authority.apply(projection(), performance.now());
    const stream = authority.watch(workspaceId, "participant", revision);
    vi.advanceTimersByTime(1);
    authority.apply(projection([], 2), performance.now());
    expect(stream.signal.aborted).toBe(true);
    authority.apply(
      projection(
        [
          {
            userId: "participant",
            role: "member",
            accessVersion: "20000000-0000-4000-8000-000000000002",
          },
        ],
        3,
      ),
      performance.now(),
    );
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
  });
  it("rejects an out-of-order response without undoing a newer revocation", () => {
    const old = performance.now();
    vi.advanceTimersByTime(1);
    authority.apply(projection([], 2), performance.now());
    expect(() => authority.apply(projection(), old)).toThrow("Stale");
    expect(() => authority.apply(projection(), performance.now())).toThrow("regressed");
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
  });
  it("has no authority after process restart and cannot initialize from an expired reply", () => {
    const cached = projection();
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
    const started = performance.now();
    vi.advanceTimersByTime(300_001);
    expect(() => authority.apply(cached, started)).toThrow("expired");
  });
  it("retains a received revocation even when persisting its projection fails", () => {
    const old = performance.now();
    authority.apply(projection(), old);
    vi.advanceTimersByTime(1);
    const fresh = performance.now();
    expect(authority.restrict(projection([], 2), fresh)).toEqual([workspaceId]);
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
    expect(() => authority.apply(projection(), old)).toThrow("Stale");
    expect(() => authority.apply(projection(), performance.now())).toThrow("regressed");
  });
  it("rejects a reply started before another process reported revocation", () => {
    const old = performance.now();
    authority.apply(projection(), old);
    const stream = authority.watch(workspaceId, "participant", revision);
    vi.advanceTimersByTime(1);
    authority.invalidate(workspaceId);
    expect(stream.signal.aborted).toBe(true);
    expect(() => authority.apply(projection(), old)).toThrow("Stale");
    vi.advanceTimersByTime(1);
    authority.apply(projection([], 2), performance.now());
    expect(authority.permits(workspaceId, "participant", revision)).toBe(false);
  });
  it("revokes omitted or disabled workspaces and cleans up completed stream observers", () => {
    authority.apply(projection(), performance.now());
    const finished = authority.watch(workspaceId, "participant", revision);
    finished.dispose();
    const stream = authority.watch(workspaceId, "participant", revision);
    const next = projection();
    next.workspaces = [];
    authority.apply(next, performance.now());
    expect(stream.signal.aborted).toBe(true);
    expect(finished.signal.aborted).toBe(false);
    expect(authority.watch(workspaceId, "participant", revision).signal.aborted).toBe(true);
  });
});
