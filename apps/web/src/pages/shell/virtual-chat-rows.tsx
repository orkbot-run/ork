// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Range } from "@tanstack/react-virtual";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, RefObject } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

const OVERSCAN = 6;
const WINDOW_THRESHOLD = 32;
const INITIAL_RECT = { width: 0, height: 600 };
const estimateSize = () => 80;
export type ChatWindowScroll = {
  toEnd: (behavior: "auto" | "smooth") => void;
  cancel: () => void;
};

/** Measure whole message rows, including dividers, and keep unmounted rows' space in the flow. */
export function VirtualChatRows<Row>({
  rows,
  getKey,
  layoutKey,
  renderAll = false,
  startAtEnd = true,
  keepKeys,
  gap = 8,
  scrollControllerRef,
  children,
}: {
  rows: readonly Row[];
  getKey: (row: Row) => string;
  layoutKey?: string;
  renderAll?: boolean;
  startAtEnd?: boolean;
  keepKeys?: readonly (string | undefined)[];
  gap?: number;
  scrollControllerRef?: RefObject<ChatWindowScroll | null>;
  children: (row: Row) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const positioned = useRef(false);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string>();
  const hasRows = rows.length > 0;
  const enabled = rows.length > WINDOW_THRESHOLD;
  const windowed = enabled && !renderAll;
  const keys = useMemo(() => rows.map(getKey), [rows, getKey]);
  const indexes = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const getItemKey = useCallback((index: number) => keys[index]!, [keys]);
  const getScrollElement = useCallback(() => listRef.current?.parentElement ?? null, []);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const visible = new Set(defaultRangeExtractor(range));
      for (const key of [focusedKey, ...(keepKeys ?? [])]) {
        const index = key === undefined ? undefined : indexes.get(key);
        if (index !== undefined) visible.add(index);
      }
      return [...visible].sort((left, right) => left - right);
    },
    [focusedKey, keepKeys, indexes],
  );

  useLayoutEffect(() => {
    const scroller = getScrollElement();
    const list = listRef.current;
    if (!enabled || !scroller || !list) return;
    const measure = () => {
      setScrollMargin(
        Math.max(
          0,
          list.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top +
            scroller.scrollTop -
            scroller.clientTop,
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    for (let header = list.previousElementSibling; header; header = header.previousElementSibling) {
      observer.observe(header);
    }
    return () => observer.disconnect();
  }, [enabled, getScrollElement, layoutKey]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled,
    getScrollElement,
    getItemKey,
    estimateSize,
    initialRect: INITIAL_RECT,
    scrollMargin,
    anchorTo: "end",
    // The main transcript owns tail-following and can deliberately keep a
    // jump close to the end pinned to its message instead of the tail.
    scrollEndThreshold: scrollControllerRef ? -1 : 1,
    useAnimationFrameWithResizeObserver: true,
    overscan: OVERSCAN,
    rangeExtractor,
    gap,
  });
  useLayoutEffect(() => {
    if (!windowed || !scrollControllerRef) return;
    scrollControllerRef.current = {
      toEnd: (behavior) => virtualizer.scrollToEnd({ behavior }),
      cancel: virtualizer.cancelScroll,
    };
    return () => {
      scrollControllerRef.current = null;
    };
  }, [scrollControllerRef, virtualizer, windowed]);
  useLayoutEffect(() => {
    if (positioned.current || !hasRows) return;
    positioned.current = true;
    // The first committed spacer gives the browser a scroll range before its
    // visible rows have been measured. Reconcile the end as those sizes arrive.
    if (windowed && startAtEnd) virtualizer.scrollToEnd();
  }, [hasRows, startAtEnd, virtualizer, windowed]);
  if (!hasRows) return null;

  let previousEnd = scrollMargin;
  const windowRows = windowed ? virtualizer.getVirtualItems() : [];
  const mounted = windowed
    ? windowRows.map(({ index, start, end }) => {
        const spaceBefore = Math.max(0, start - previousEnd);
        previousEnd = end;
        return { index, spaceBefore };
      })
    : rows.map((_, index) => ({ index, spaceBefore: index === 0 ? 0 : gap }));
  const remaining = windowed
    ? Math.max(0, virtualizer.getTotalSize() + scrollMargin - previousEnd)
    : 0;

  return (
    <div
      ref={listRef}
      className="flex shrink-0 flex-col"
      data-chat-window={windowed ? "virtual" : "expanded"}
      onFocusCapture={(event) => {
        setFocusedKey(event.target.closest<HTMLElement>("[data-chat-row]")?.dataset.chatRow);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(undefined);
      }}
    >
      {mounted.map(({ index, spaceBefore }) => (
        <div
          key={keys[index]}
          ref={enabled ? virtualizer.measureElement : undefined}
          data-index={index}
          data-chat-row={keys[index]}
          className="flex min-w-0 flex-col gap-2"
          style={{ marginTop: spaceBefore }}
        >
          {children(rows[index]!)}
        </div>
      ))}
      {remaining > 0 ? <div aria-hidden="true" style={{ height: remaining }} /> : null}
    </div>
  );
}
