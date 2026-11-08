// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type {
  MessagingLinkedIdentity,
  MessagingOutboundList,
  MessagingStatus,
} from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const presses = vi.hoisted(() => new Map<string, () => void>());
const api = vi.hoisted(() => ({ send: vi.fn(), generation: 0, server: "initial", selection: 0 }));
vi.mock("./settings-target", () => ({
  captureSettingsContext: vi.fn(() => {
    const { generation, server, selection } = api;
    return {
      send: api.send,
      isCurrent: () =>
        generation === api.generation && server === api.server && selection === api.selection,
    };
  }),
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({ useMobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => {
    presses.set(label, onPress);
    return (
      <button type="button" onClick={onPress} disabled={disabled || busy}>
        {label}
      </button>
    );
  },
}));
vi.mock("react-native", () => {
  const View = ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <div role={accessibilityRole}>{children}</div>;
  return { View, Text: View, ScrollView: View, Modal: View };
});

import { MessagingDeliveryReview } from "../components/messaging-delivery-review";
import { captureSettingsContext } from "./settings-target";

const identity: MessagingLinkedIdentity = {
  id: "identity-1",
  provider: "fixture",
  address: "fixture-address",
  botId: "bot-1",
  botName: "Bot",
};
const review = { spaceId: "review-space", count: 1 };
const item = {
  id: "outbound-1",
  version: "a".repeat(64),
  preview: "An update with an unknown delivery outcome",
  createdAt: "2026-01-01T00:00:00Z",
  attachmentName: "report.txt",
};
const result: MessagingOutboundList = { items: [item], hasMore: false };
const status: MessagingStatus = { enabled: true, providers: [], openSignup: false, identities: [] };
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
let owner: { isCurrent: () => boolean };
let onStatus: ReturnType<typeof vi.fn<(status: MessagingStatus) => void>>;
async function render(next = identity) {
  await act(async () =>
    root.render(
      <MessagingDeliveryReview identity={next} review={review} owner={owner} onStatus={onStatus} />,
    ),
  );
}
async function open() {
  await act(async () => container.querySelector("button")?.click());
}
function decision(label: string) {
  const callback = presses.get(label);
  if (!callback) throw new Error(`Missing decision ${label}`);
  return callback;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  presses.clear();
  api.generation = 0;
  api.server = "initial";
  api.selection = 0;
  owner = { isCurrent: () => api.generation === 0 };
  onStatus = vi.fn();
  api.send
    .mockReset()
    .mockImplementation(async (path: string) =>
      path === "messaging/outbound/list"
        ? result
        : path === "messaging/status"
          ? status
          : { ok: true },
    );
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
it.each([
  ["Mark as sent", "confirmed_sent"],
  ["Mark as not sent", "confirmed_not_sent"],
] as const)(
  "%s records a reviewed result through the original context",
  async (label, resolution) => {
    await render();
    await open();
    expect(captureSettingsContext).toHaveBeenLastCalledWith({
      scope: "space",
      spaceId: review.spaceId,
    });
    expect(container.textContent).toContain(item.preview);
    expect(container.textContent).toContain("without resending");
    await act(async () => decision(label)());
    expect(api.send).toHaveBeenCalledWith("messaging/outbound/resolve", {
      identityId: identity.id,
      outboundId: item.id,
      version: item.version,
      resolution,
    });
    expect(
      api.send.mock.calls.filter(([path]) => path === "messaging/outbound/resolve"),
    ).toHaveLength(1);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(status);
  },
);
it.each(["session", "server", "Space", "target"] as const)(
  "retires a captured native decision after changing %s",
  async (kind) => {
    await render();
    await open();
    const old = decision("Mark as sent");
    if (kind === "session") api.generation += 1;
    if (kind === "server") api.server = "replacement";
    if (kind === "Space") api.selection += 1;
    if (kind === "target") await render({ ...identity, botId: "bot-new" });
    else await render();
    expect(container.textContent).not.toContain(item.preview);
    await act(async () => old());
    expect(
      api.send.mock.calls.filter(([path]) => path === "messaging/outbound/resolve"),
    ).toHaveLength(0);
    expect(onStatus).not.toHaveBeenCalled();
  },
);
it.each(["resolve", "reject"] as const)(
  "ignores old pending %s and renews only with a freshly loaded owner",
  async (outcome) => {
    await render();
    await open();
    const old = deferred<{ ok: boolean }>();
    api.send.mockImplementation(async (path: string) =>
      path === "messaging/outbound/resolve"
        ? old.promise
        : path === "messaging/outbound/list"
          ? result
          : status,
    );
    await act(async () => decision("Mark as sent")());
    api.generation += 1;
    owner = { isCurrent: () => api.generation === 1 };
    api.send.mockImplementation(async (path: string) =>
      path === "messaging/outbound/list"
        ? { items: [{ ...item, preview: "Fresh owner" }], hasMore: false }
        : path === "messaging/status"
          ? status
          : { ok: true },
    );
    await render();
    await open();
    expect(container.textContent).toContain("Fresh owner");
    await act(async () => {
      if (outcome === "resolve") old.resolve({ ok: true });
      else old.reject(new Error("retired failure"));
    });
    expect(onStatus).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => decision("Mark as not sent")());
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(status);
  },
);
it("keeps an acknowledged decision when refresh fails and shows the error", async () => {
  await render();
  await open();
  api.send.mockImplementation(async (path: string) => {
    if (path === "messaging/outbound/resolve") return { ok: true };
    throw new Error("offline");
  });
  await act(async () => decision("Mark as sent")());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
  expect(
    api.send.mock.calls.filter(([path]) => path === "messaging/outbound/resolve"),
  ).toHaveLength(1);
  await open();
  expect(container.textContent).not.toContain(item.preview);
});
