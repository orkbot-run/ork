// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 list tests are preserved. Loading regressions follow LICENSE.md.

import type { ComponentProps, ReactNode, Ref } from "react";
import { act, createElement, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThreadMessageList } from "../components/thread/thread-message-list";
import { threadColumnPadding } from "./thread-edges";
import type { ThreadListScroll } from "./thread-list-scroll";

const native = vi.hoisted(() => ({
  os: "ios",
  flat: null as Record<string, unknown> | null,
  scroll: null as Record<string, unknown> | null,
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    ActivityIndicator: () => null,
    FlatList: (props: Record<string, unknown>) => {
      native.flat = props;
      useImperativeHandle(props.ref as Ref<unknown>, () => ({
        scrollToIndex: native.scrollToIndex,
        scrollToOffset: native.scrollToOffset,
      }));
      return createElement("div", { "data-list": "flat" });
    },
    Platform: {
      get OS() {
        return native.os;
      },
    },
    ScrollView: (props: Record<string, unknown> & { children?: ReactNode }) => {
      native.scroll = props;
      return createElement("div", { "data-list": "scroll" }, props.children);
    },
    StyleSheet: { create: <T,>(styles: T) => styles },
    View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  };
});

vi.mock("@orkbot/core", () => ({
  threadWindowMessages: (messages: unknown[]) => messages,
}));

vi.mock("../components/thread-scroll-surface", () => ({
  ThreadScrollSurface: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../components/thread/thread-list-controls", () => ({
  JumpToLatestButton: ({ insetEnd }: { insetEnd: number }) =>
    createElement("div", { "data-inset-end": String(insetEnd) }),
}));

vi.mock("../components/thread/thread-messages-skeleton", () => ({
  ThreadMessagesSkeleton: () =>
    createElement("div", { role: "progressbar", "aria-label": "Loading…" }),
}));

vi.mock("./appearance", () => ({
  mobileTokens: () => ({ mutedForeground: "muted" }),
}));

type ListProps = ComponentProps<typeof ThreadMessageList>;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return (style as Record<string, unknown>) ?? {};
}

function scroll(overrides: { showPinnedPage?: boolean; detached?: boolean } = {}) {
  return {
    helperViewport: { current: null },
    pinnedList: { current: null },
    list: { current: null },
    showPinnedPage: overrides.showPinnedPage ?? false,
    pinnedTarget: null,
    pinnedNewerCursor: null,
    behavior: { current: { onLayout: () => undefined, jumpToLatest: () => undefined } },
    state: { detached: overrides.detached ?? false, unread: false },
    jumpTarget: null,
    isPinnedJumpPending: () => false,
    layoutJumpRow: () => undefined,
    performScroll: () => undefined,
    follow: () => undefined,
    liveListHandlers: {},
  } as unknown as ThreadListScroll;
}

function listProps(
  overrides: Partial<ListProps> & { showPinnedPage?: boolean; detached?: boolean } = {},
): ListProps {
  const { showPinnedPage, detached, ...rest } = overrides;
  return {
    scroll: scroll({ showPinnedPage, detached }),
    pinnedListHandlers: {} as ListProps["pinnedListHandlers"],
    threadKey: "thread-1",
    headerClearance: { padding: 80, minHeight: 80 },
    bottomInset: 0,
    columnPadding: threadColumnPadding({ left: 40, right: 8 }, false),
    visibleMessages: [],
    liveItems: [],
    renderItem: () => null,
    renderMessageRow: () => createElement("div"),
    loadEarlierControl: null,
    failedSendBubbles: null,
    errorNotice: null,
    workingFooter: null,
    initialLoading: false,
    loadingNewer: false,
    showLatest: () => undefined,
    ...rest,
  };
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.os = "ios";
  native.flat = null;
  native.scroll = null;
  native.scrollToIndex.mockReset();
  native.scrollToOffset.mockReset();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

it("shows loading placeholders until the conversation is ready without replacing the list", async () => {
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ThreadMessageList, listProps({ initialLoading: true }))),
  );
  expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(container.querySelector('[data-list="flat"]')).not.toBeNull();

  await act(async () => root.render(createElement(ThreadMessageList, listProps())));
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.querySelector('[data-list="flat"]')).not.toBeNull();
  await act(async () => root.unmount());
});

it("pads message content and leaves the live list frame on the screen edge", async () => {
  const root = createRoot(container);
  await act(async () => root.render(createElement(ThreadMessageList, listProps())));
  const frame = flatten(native.flat?.style);
  const content = flatten(native.flat?.contentContainerStyle);
  expect(frame).toEqual({ flex: 1 });
  expect(content).toMatchObject({ paddingStart: 60, paddingEnd: 28, paddingBottom: 80 });
  await act(async () => root.unmount());
});

it("pads a pinned page the same way and keeps the jump button on the column edge", async () => {
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ThreadMessageList, listProps({ showPinnedPage: true }))),
  );
  const frame = flatten(native.flat?.style);
  const content = flatten(native.flat?.contentContainerStyle);
  expect(frame).toEqual({ flex: 1 });
  expect(content).toMatchObject({ paddingStart: 60, paddingEnd: 28, paddingTop: 80 });
  expect(container.querySelector("[data-inset-end]")?.getAttribute("data-inset-end")).toBe("28");
  await act(async () => root.unmount());
});

it("swaps the live list's side padding for Android's mirrored inverted list only", async () => {
  native.os = "android";
  const root = createRoot(container);
  await act(async () => root.render(createElement(ThreadMessageList, listProps())));
  const live = flatten(native.flat?.contentContainerStyle);
  expect(live).toMatchObject({ paddingStart: 28, paddingEnd: 60 });
  await act(async () =>
    root.render(createElement(ThreadMessageList, listProps({ showPinnedPage: true }))),
  );
  const pinned = flatten(native.flat?.contentContainerStyle);
  expect(pinned).toMatchObject({ paddingStart: 60, paddingEnd: 28 });
  await act(async () => root.unmount());
});

it("virtualizes pinned messages and retries an unmeasured quote until its cell mounts", async () => {
  vi.useFakeTimers();
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: `message-${index}` }));
  let pending = true;
  const layout = vi.fn(() => {
    pending = false;
  });
  const pinnedScroll = {
    ...scroll({ showPinnedPage: true }),
    jumpTarget: "message-150",
    isPinnedJumpPending: () => pending,
    layoutJumpRow: layout,
  } as unknown as ThreadListScroll;
  const renderMessageRow = vi.fn(() => createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          ThreadMessageList,
          listProps({
            scroll: pinnedScroll,
            visibleMessages: messages as ListProps["visibleMessages"],
            renderMessageRow,
          }),
        ),
      ),
    );
    expect(native.flat?.data).toEqual(messages);
    expect(renderMessageRow).not.toHaveBeenCalled();
    expect(native.flat?.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    expect(native.scroll).toBeNull();
    expect(native.scrollToIndex).toHaveBeenCalledWith({
      index: 150,
      viewOffset: 80,
      animated: false,
    });
    const fail = native.flat?.onScrollToIndexFailed as (info: {
      index: number;
      averageItemLength: number;
    }) => void;
    act(() => fail({ index: 150, averageItemLength: 60 }));
    expect(native.scrollToOffset).toHaveBeenCalledWith({ offset: 8920, animated: false });
    native.scrollToIndex.mockClear();
    act(() => vi.advanceTimersByTime(100));
    expect(native.scrollToIndex).toHaveBeenCalledOnce();
    // A message's own layout is relative to its cell; use the cell's content offset.
    const Cell = native.flat?.CellRendererComponent as (props: Record<string, unknown>) => {
      props: { onLayout: (event: unknown) => void };
    };
    const onLayout = vi.fn();
    act(() =>
      Cell({ item: messages[150], index: 150, onLayout }).props.onLayout({
        nativeEvent: { layout: { y: 9500 } },
      }),
    );
    expect(onLayout).toHaveBeenCalledOnce();
    expect(layout).toHaveBeenCalledWith("message-150", 9500, 150);
    native.scrollToIndex.mockClear();
    act(() => {
      fail({ index: 150, averageItemLength: 60 });
      vi.advanceTimersByTime(100);
    });
    expect(native.scrollToIndex).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
