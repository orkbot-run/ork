// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MessagingOutboundList, MessagingOutboundReview } from "@orkbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMessagingDeliveryReview } from "./messaging-delivery-review.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const item: MessagingOutboundReview = {
  id: "outbound-1",
  version: "a".repeat(64),
  preview: "A committed update",
  createdAt: "2026-01-01T00:00:00Z",
  attachmentName: null,
};
const result = (items = [item]): MessagingOutboundList => ({ items, hasMore: false });
function fixture() {
  let owned = true;
  const list = vi.fn(async () => result());
  const resolve = vi.fn(async () => ({ ok: true }));
  const refreshContext = vi.fn(async () => undefined);
  const review = createMessagingDeliveryReview({
    isCurrent: () => owned,
    list,
    resolve,
    refreshContext,
  });
  return {
    review,
    list,
    resolve,
    refreshContext,
    retire: () => {
      owned = false;
    },
  };
}

describe("delivery review", () => {
  it("refreshes a stale review badge when another actor already resolved the remaining rows", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce(result([]));
    await f.review.load();
    expect(f.refreshContext).toHaveBeenCalledOnce();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.review.getSnapshot()).toMatchObject({ items: [], error: null });
  });
  it.each(["confirmed_sent", "confirmed_not_sent"] as const)(
    "records %s without issuing any second resolution and refreshes after the receipt",
    async (resolution) => {
      const f = fixture();
      const ack = deferred<{ ok: boolean }>();
      await f.review.load();
      f.resolve.mockReturnValueOnce(ack.promise);
      f.list.mockResolvedValueOnce(result([]));
      const saving = f.review.resolve(item, resolution);
      await f.review.resolve(item, resolution);
      expect(f.resolve).toHaveBeenCalledExactlyOnceWith(item, resolution);
      expect(f.refreshContext).not.toHaveBeenCalled();
      expect(f.list).toHaveBeenCalledTimes(1);
      ack.resolve({ ok: true });
      await saving;
      expect(f.refreshContext).toHaveBeenCalledOnce();
      expect(f.list).toHaveBeenCalledTimes(2);
      expect(f.review.getSnapshot()).toMatchObject({ items: [], pending: false, error: null });
    },
  );
  it("keeps a confirmed removal if the remaining list and context refresh fail", async () => {
    const f = fixture();
    await f.review.load();
    const offline = new Error("offline");
    f.list.mockRejectedValueOnce(offline);
    f.refreshContext.mockRejectedValueOnce(offline);
    await f.review.resolve(item, "confirmed_sent");
    expect(f.review.getSnapshot()).toMatchObject({ items: [], pending: false, error: offline });
    await f.review.resolve(item, "confirmed_not_sent");
    expect(f.resolve).toHaveBeenCalledOnce();
  });
  it("keeps the unresolved item and permits an explicit retry after a rejected decision", async () => {
    const f = fixture();
    await f.review.load();
    const conflict = new Error("stale version");
    f.resolve.mockRejectedValueOnce(conflict);
    await f.review.resolve(item, "confirmed_sent");
    expect(f.review.getSnapshot()).toMatchObject({
      items: [item],
      error: conflict,
      pending: false,
    });
    expect(f.refreshContext).not.toHaveBeenCalled();
    f.list.mockResolvedValueOnce(result([]));
    await f.review.resolve(item, "confirmed_not_sent");
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });
  it.each(["resolve", "reject"] as const)(
    "ignores a late %s after closing and reopening",
    async (outcome) => {
      const f = fixture();
      const old = deferred<MessagingOutboundList>();
      f.list.mockReturnValueOnce(old.promise);
      const loading = f.review.load();
      f.review.close();
      f.list.mockResolvedValueOnce(result([{ ...item, id: "current" }]));
      await f.review.load();
      if (outcome === "resolve") old.resolve(result());
      else old.reject(new Error("old failure"));
      await loading;
      expect(f.review.getSnapshot()).toMatchObject({
        items: [{ ...item, id: "current" }],
        pending: false,
        error: null,
      });
    },
  );
  it.each(["resolve", "reject"] as const)(
    "retires old owner's %s without refreshing replacement context",
    async (outcome) => {
      const f = fixture();
      await f.review.load();
      const old = deferred<{ ok: boolean }>();
      f.resolve.mockReturnValueOnce(old.promise);
      const saving = f.review.resolve(item, "confirmed_sent");
      f.retire();
      if (outcome === "resolve") old.resolve({ ok: true });
      else old.reject(new Error("old failure"));
      await saving;
      expect(f.refreshContext).not.toHaveBeenCalled();
      expect(f.list).toHaveBeenCalledTimes(1);
      await f.review.load();
      await f.review.resolve(item, "confirmed_sent");
      expect(f.resolve).toHaveBeenCalledOnce();
    },
  );
  it("rejects a stale receipt from a previous list version", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce(result([{ ...item, version: "b".repeat(64) }]));
    await f.review.load();
    await f.review.resolve(item, "confirmed_sent");
    expect(f.resolve).not.toHaveBeenCalled();
  });
});
