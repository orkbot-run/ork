// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { PrismaClient } from "@orkbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthRefreshSignal, withOAuthRefreshLock } from "./oauth-refresh-lock.js";

afterEach(() => vi.restoreAllMocks());

describe("withOAuthRefreshLock", () => {
  it("sets a transaction-local wait limit before taking the parameterized credential lock", async () => {
    const events: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
        events.push(sql.join("?"));
        return 1;
      }),
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<string>) => work(tx));
    const result = await withOAuthRefreshLock(
      { $transaction: transaction } as unknown as PrismaClient,
      "model-oauth",
      "user-1:provider-1",
      async (client) => {
        expect(client).toBe(tx);
        events.push("refresh");
        return "new-access";
      },
    );

    expect(result).toBe("new-access");
    expect(events).toEqual([
      "SELECT set_config('lock_timeout', ?, true)",
      "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      "refresh",
    ]);
    expect(tx.$executeRaw.mock.calls[0]?.slice(1)).toEqual(["10000ms"]);
    expect(tx.$executeRaw.mock.calls[1]?.slice(1)).toEqual(["model-oauth", "user-1:provider-1"]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 60_000,
    });
  });

  it("does not contact the provider when the database cannot acquire the lock", async () => {
    const failure = new Error("lock wait timed out");
    const tx = { $executeRaw: vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(failure) };
    const work = vi.fn();
    const prisma = {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    };

    await expect(
      withOAuthRefreshLock(prisma as never, "model-oauth", "user-1:provider-1", work),
    ).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("oauthRefreshSignal", () => {
  it("caps the provider request at fifteen seconds even when a caller supplies a signal", () => {
    const deadline = new AbortController();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const signal = oauthRefreshSignal(caller.signal);

    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(signal.aborted).toBe(false);
    deadline.abort(new Error("provider deadline"));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(deadline.signal.reason);
    expect(caller.signal.aborted).toBe(false);
  });

  it("preserves an earlier caller cancellation", () => {
    const caller = new AbortController();
    const reason = new Error("run cancelled");
    caller.abort(reason);

    const signal = oauthRefreshSignal(caller.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });
});
