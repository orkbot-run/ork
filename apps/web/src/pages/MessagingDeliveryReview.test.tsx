// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MessagingLinkedIdentity, MessagingOutboundList } from "@orkbot/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  status: vi.fn(),
  generation: 0,
  user: "owner",
}));
const queries = vi.hoisted(() => ({ messaging: { status: { queryKey: () => ["status"] } } }));
vi.mock("../lib/query", () => ({ useSpaceQueries: () => queries, useQueryUserId: () => "owner" }));
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({
      data: { session: { id: `session-${api.generation}` }, user: { id: api.user } },
    }),
  },
}));
vi.mock("../lib/rpc", () => ({
  captureRpcContext: vi.fn(() => {
    const generation = api.generation;
    return {
      isCurrent: () => generation === api.generation,
      client: {
        messaging: { outbound: { list: api.list, resolve: api.resolve }, status: api.status },
      },
    };
  }),
}));
vi.mock("../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({ children, disabled, onClick }: ComponentProps<"button">) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

import { captureRpcContext } from "../lib/rpc";
import { MessagingDeliveryReview } from "./MessagingDeliveryReview";

const identity: MessagingLinkedIdentity = {
  id: "identity-1",
  provider: "fixture",
  address: "fixture-address",
  botId: "bot-1",
  botName: "Bot",
};
const review = { spaceId: "origin-space", count: 1 };
const item = {
  id: "outbound-1",
  version: "a".repeat(64),
  preview: "<img src=x onerror=alert(1)> committed text",
  createdAt: "2026-01-01T00:00:00Z",
  attachmentName: "report.txt",
};
const result: MessagingOutboundList = { items: [item], hasMore: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: QueryClient;
async function render(next = identity) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MessagingDeliveryReview identity={next} review={review} />
      </QueryClientProvider>,
    ),
  );
}
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.generation = 0;
  api.user = "owner";
  api.list.mockReset().mockResolvedValue(result);
  api.resolve.mockReset().mockResolvedValue({ ok: true });
  api.status.mockReset().mockResolvedValue({
    enabled: true,
    providers: [],
    openSignup: false,
    identities: [{ ...identity, deliveryReview: { ...review, count: 0 } }],
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  cache.clear();
  vi.unstubAllGlobals();
});
it.each([
  ["Mark as sent", "confirmed_sent"],
  ["Mark as not sent", "confirmed_not_sent"],
] as const)(
  "%s records the manual result after review, with no retry command",
  async (label, resolution) => {
    await render();
    expect(api.list).not.toHaveBeenCalled();
    await click("Review delivery");
    expect(captureRpcContext).toHaveBeenLastCalledWith("origin-space");
    expect(api.list).toHaveBeenCalledExactlyOnceWith({ identityId: identity.id });
    expect(container.textContent).toContain(item.preview);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("without resending");
    api.list.mockResolvedValueOnce({ items: [], hasMore: false });
    await click(label);
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith({
      identityId: identity.id,
      outboundId: item.id,
      version: item.version,
      resolution,
    });
    expect(api.status).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain(item.preview);
    expect(cache.getQueryData(["status"])).toMatchObject({
      identities: [{ deliveryReview: { count: 0 } }],
    });
  },
);
it("keeps the acknowledged result when the next refresh fails", async () => {
  await render();
  await click("Review delivery");
  api.list.mockRejectedValueOnce(new Error("offline"));
  await click("Mark as sent");
  expect(container.textContent).not.toContain(item.preview);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't update messaging settings",
  );
  expect(api.resolve).toHaveBeenCalledOnce();
});
it.each(["resolve", "reject"] as const)(
  "ignores old list %s after retargeting and supports a fresh review",
  async (outcome) => {
    const old = deferred<MessagingOutboundList>();
    api.list.mockReturnValueOnce(old.promise);
    await render();
    await click("Review delivery");
    api.status.mockResolvedValueOnce({
      enabled: true,
      providers: [],
      openSignup: false,
      identities: [{ ...identity, botId: "bot-new", deliveryReview: review }],
    });
    await render({ ...identity, botId: "bot-new" });
    api.list.mockResolvedValueOnce({
      items: [{ ...item, preview: "Fresh target" }],
      hasMore: false,
    });
    await click("Review delivery");
    await act(async () => {
      if (outcome === "resolve") old.resolve(result);
      else old.reject(new Error("retired failure"));
    });
    expect(container.textContent).toContain("Fresh target");
    expect(container.textContent).not.toContain(item.preview);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);
it.each(["resolve", "reject"] as const)(
  "ignores old decision %s after owner retirement",
  async (outcome) => {
    const old = deferred<{ ok: boolean }>();
    await render();
    await click("Review delivery");
    api.resolve.mockReturnValueOnce(old.promise);
    await click("Mark as sent");
    api.generation += 1;
    await act(async () => {
      if (outcome === "resolve") old.resolve({ ok: true });
      else old.reject(new Error("retired failure"));
    });
    expect(api.status).not.toHaveBeenCalled();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(cache.getQueryData(["status"])).toBeUndefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  },
);
it("retires a closed list before reopening it", async () => {
  await render();
  await click("Review delivery");
  await click("Close");
  api.list.mockResolvedValueOnce({
    items: [{ ...item, version: "b".repeat(64), preview: "Refreshed" }],
    hasMore: false,
  });
  await click("Review delivery");
  await click("Mark as not sent");
  expect(api.resolve).toHaveBeenCalledWith(expect.objectContaining({ version: "b".repeat(64) }));
});

it.each(["resolve", "reject"] as const)(
  "renews a same-account session only after a fresh identity read and fences the old %s",
  async (outcome) => {
    const old = deferred<{ ok: boolean }>();
    await render();
    await click("Review delivery");
    api.resolve.mockReturnValueOnce(old.promise);
    await click("Mark as sent");
    const fresh = deferred<Awaited<ReturnType<typeof api.status>>>();
    api.status.mockReturnValueOnce(fresh.promise);
    api.generation += 1;
    await render();
    expect(button("Review delivery").disabled).toBe(true);
    expect(container.textContent).not.toContain(item.preview);
    await act(async () => {
      if (outcome === "resolve") old.resolve({ ok: true });
      else old.reject(new Error("old failure"));
    });
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(cache.getQueryData(["status"])).toBeUndefined();
    await act(async () =>
      fresh.resolve({
        enabled: true,
        providers: [],
        openSignup: false,
        identities: [{ ...identity, deliveryReview: review }],
      }),
    );
    expect(button("Review delivery").disabled).toBe(false);
    await click("Review delivery");
    await click("Mark as not sent");
    expect(api.resolve).toHaveBeenCalledTimes(2);
    expect(api.status).toHaveBeenCalledTimes(2);
  },
);
it("never adopts the previous user's cached identity while query ownership is changing", async () => {
  await render();
  await click("Review delivery");
  api.generation += 1;
  api.user = "replacement";
  await render();
  expect(button("Review delivery").disabled).toBe(true);
  expect(container.textContent).not.toContain(item.preview);
  expect(api.status).not.toHaveBeenCalled();
  expect(api.list).toHaveBeenCalledTimes(1);
});
