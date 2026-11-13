// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it, vi } from "vitest";
import {
  createPendingRevocations,
  MAX_PENDING_REVOCATIONS,
  REVOCATION_RETENTION_MS,
} from "./pending-revocations.js";

function harness() {
  let value: string | null = null;
  let now = 1_800_000_000_000;
  const send = vi.fn(async () => false);
  const options = {
    read: async () => value,
    write: async (next: string) => {
      value = next;
    },
    send,
    now: () => now,
  };
  return {
    queue: createPendingRevocations(options),
    send,
    restart: () => createPendingRevocations(options),
    entries: () => JSON.parse(value ?? "[]"),
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const retired = (token = "old-session") => ({
  kind: "session" as const,
  origin: "https://server.example.test",
  token,
  headers: { "x-proxy-token": "proxy-secret" },
});

describe("pending session revocation", () => {
  it("persists the workspace target across process restart without authorizing a different account", async () => {
    const h = harness();
    const workspace = {
      account: JSON.stringify(["https://accounts.example.test", "user-one"]),
      target: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        serverId: "10000000-0000-4000-8000-000000000002",
        workspaceId: "10000000-0000-4000-8000-000000000003",
        bindingVersion: 1,
        keyFingerprint: "a".repeat(64),
      },
    };
    await h.queue.enqueue({ ...retired(), workspace });
    await h.restart().retry();
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
    expect(h.entries()[0].workspace).toEqual(workspace);
    await expect(
      h.queue.enqueue({ ...retired(), workspace: { ...workspace, account: "corrupt" } }),
    ).rejects.toThrow("Invalid pending revocation");
    await expect(
      h.queue.enqueue({
        ...retired(),
        workspace: { ...workspace, target: { ...workspace.target, keyFingerprint: "corrupt" } },
      }),
    ).rejects.toThrow("Invalid pending revocation");
  });
  it("does not lose a logout trigger behind an empty startup flush", async () => {
    let stored: string | null = null;
    let release!: () => void;
    const read = vi.fn(async () => stored);
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    const send = vi.fn(async () => true);
    const queue = createPendingRevocations({
      read,
      write: async (value) => {
        stored = value;
      },
      send,
    });
    const startup = queue.retry();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = queue.enqueue(retired());
    const logout = queue.retry();
    release();
    await Promise.all([startup, queued, logout]);
    expect(send).toHaveBeenCalledOnce();
    expect(stored).toBe("[]");
  });
  it("retains failed revocations across launches and retires only acknowledged snapshots", async () => {
    const h = harness();
    await h.queue.enqueue(retired());
    await h.queue.retry();
    expect(h.entries()).toHaveLength(1);
    h.send.mockResolvedValue(true);
    await h.restart().retry();
    expect(h.send).toHaveBeenLastCalledWith(expect.objectContaining(retired()));
    expect(h.entries()).toEqual([]);
  });

  it("does not remove another server or session queued while a send is pending", async () => {
    const h = harness();
    await h.queue.enqueue(retired());
    let finish!: (ok: boolean) => void;
    h.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const retry = h.queue.retry();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.queue.retry()).toBe(retry);
    await h.queue.enqueue({ ...retired("new-session"), origin: "https://other.example.test" });
    finish(true);
    await retry;
    expect(h.entries()).toEqual([
      expect.objectContaining({ token: "new-session", origin: "https://other.example.test" }),
    ]);
  });

  it("bounds retention and count without extending a repeated credential's lifetime", async () => {
    const h = harness();
    await h.queue.enqueue(retired());
    h.advance(REVOCATION_RETENTION_MS - 1);
    await h.queue.enqueue(retired());
    h.advance(1);
    await h.queue.retry();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.entries()).toEqual([]);
    for (let i = 0; i <= MAX_PENDING_REVOCATIONS; i += 1)
      await h.queue.enqueue(retired(`token-${i}`));
    expect(h.entries()).toHaveLength(MAX_PENDING_REVOCATIONS);
    expect(h.entries().some((entry: { token: string }) => entry.token === "token-0")).toBe(false);
  });

  it("rejects unbounded credentials and unsafe destinations", async () => {
    const h = harness();
    for (const origin of [
      "http://public.example.test",
      "https://user:pass@server.example.test",
      "https://server.example.test/other",
      "file:///tmp/file",
    ]) {
      await expect(h.queue.enqueue({ ...retired(), origin })).rejects.toThrow(
        "Invalid pending revocation",
      );
    }
    await expect(h.queue.enqueue(retired("x".repeat(16385)))).rejects.toThrow();
    await h.queue.enqueue({ ...retired(), origin: "http://127.0.0.1:5199" });
    expect(h.entries()).toHaveLength(1);
  });
});
