// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Range } from "@tanstack/react-virtual";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode, RefObject } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const SidebarScrollContext = createContext<RefObject<HTMLDivElement | null>>({
  current: null,
});

const NO_PINNED_KEYS: readonly string[] = [];

/** Keeps each section in the shared sidebar scroller, including its keyboard tab order. */
export function VirtualSidebarList<T>({
  items,
  getItemKey,
  estimateSize,
  children,
  className,
  grid = false,
  pinnedKeys = NO_PINNED_KEYS,
}: {
  items: readonly T[];
  getItemKey: (item: T) => string;
  estimateSize: number;
  children: (item: T) => ReactNode;
  className?: string;
  grid?: boolean;
  pinnedKeys?: readonly string[];
}) {
  const scroller = useContext(SidebarScrollContext);
  const container = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [columns, setColumns] = useState(1);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const enabled = items.length > 40;
  useLayoutEffect(() => {
    if (!grid || !enabled) {
      setColumns(1);
      return;
    }
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setColumns(query.matches ? 3 : 1);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [enabled, grid]);
  useLayoutEffect(() => {
    const element = container.current;
    const scrollElement = scroller.current;
    if (!element || !scrollElement || !enabled) return;
    const update = () =>
      setScrollMargin(
        element.getBoundingClientRect().top -
          scrollElement.getBoundingClientRect().top +
          scrollElement.scrollTop,
      );
    update();
    // Sections before this one can expand, collapse or change density.
    const observer = new ResizeObserver(update);
    observer.observe(scrollElement);
    if (scrollElement.firstElementChild) observer.observe(scrollElement.firstElementChild);
    for (const sibling of scrollElement.querySelectorAll("[data-sidebar-group]"))
      observer.observe(sibling);
    return () => observer.disconnect();
  }, [scroller, enabled, items.length]);
  const rowByKey = useMemo(
    () => new Map(items.map((item, index) => [getItemKey(item), Math.floor(index / columns)])),
    [items, getItemKey, columns],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const rows = new Set(defaultRangeExtractor(range));
      for (const key of [...pinnedKeys, ...(focusedKey ? [focusedKey] : [])]) {
        const row = rowByKey.get(key);
        if (row !== undefined) rows.add(row);
      }
      return [...rows].sort((a, b) => a - b);
    },
    [rowByKey, pinnedKeys, focusedKey],
  );
  const rowKey = useCallback(
    (index: number) => getItemKey(items[index * columns]!),
    [getItemKey, items, columns],
  );
  const virtualizer = useVirtualizer({
    count: Math.ceil(items.length / columns),
    getScrollElement: () => scroller.current,
    enabled,
    estimateSize: () => estimateSize + (columns > 1 ? 6 : 2),
    getItemKey: rowKey,
    overscan: 5,
    useAnimationFrameWithResizeObserver: true,
    scrollMargin,
    rangeExtractor,
  });
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, estimateSize, columns]);
  if (!enabled)
    return (
      <div className={className}>
        {items.map((item) => (
          <div key={getItemKey(item)} className="h-full min-w-0">
            {children(item)}
          </div>
        ))}
      </div>
    );
  return (
    <div
      ref={container}
      data-sidebar-virtual-list
      style={{ height: virtualizer.getTotalSize(), position: "relative", flexShrink: 0 }}
      onBlurCapture={() => {
        queueMicrotask(() => {
          if (!container.current?.contains(document.activeElement)) setFocusedKey(null);
        });
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
        const cell = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-sidebar-virtual-index]",
        );
        if (!cell) return;
        const controls = cell.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], [tabindex="0"]',
        );
        const boundary = event.shiftKey ? controls[0] : controls[controls.length - 1];
        if (event.target !== boundary) return;
        const next = Number(cell.dataset.sidebarVirtualIndex) + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= items.length) return;
        event.preventDefault();
        setFocusedKey(getItemKey(items[next]!));
        virtualizer.scrollToIndex(Math.floor(next / columns), { align: "auto" });
        let remaining = 8;
        const focus = () => {
          const nextCell = container.current?.querySelector<HTMLElement>(
            `[data-sidebar-virtual-index="${next}"]`,
          );
          const targets = nextCell?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          );
          const target = targets?.[event.shiftKey ? targets.length - 1 : 0];
          if (target) target.focus();
          else if (--remaining > 0) requestAnimationFrame(focus);
        };
        requestAnimationFrame(focus);
      }}
      onFocusCapture={(event) => {
        const cell = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-sidebar-virtual-key]",
        );
        if (cell) setFocusedKey(cell.dataset.sidebarVirtualKey ?? null);
      }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          data-index={row.index}
          ref={virtualizer.measureElement}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${row.start - scrollMargin}px)`,
            paddingBottom: columns > 1 ? 6 : 2,
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: columns > 1 ? 6 : 0,
          }}
        >
          {items.slice(row.index * columns, (row.index + 1) * columns).map((item, offset) => (
            <div
              key={getItemKey(item)}
              className="h-full min-w-0"
              data-sidebar-virtual-key={getItemKey(item)}
              data-sidebar-virtual-index={row.index * columns + offset}
            >
              {children(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
