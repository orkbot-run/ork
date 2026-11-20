// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 message lists are preserved. Loading placeholders follow LICENSE.md.

import type { ThreadItem } from "@orkbot/core";
import { threadWindowMessages } from "@orkbot/core";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useRef } from "react";
import type { CellRendererProps, ListRenderItem } from "react-native";
import { ActivityIndicator, FlatList, Platform, StyleSheet, View } from "react-native";
import type { MobileMessage } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import type { ThreadColumnPadding } from "../../lib/thread-edges";
import type { ThreadListScroll } from "../../lib/thread-list-scroll";
import type { useThreadPaging } from "../../lib/thread-paging";
import { ThreadScrollSurface } from "../thread-scroll-surface";
import { JumpToLatestButton } from "./thread-list-controls";
import { ThreadMessagesSkeleton } from "./thread-messages-skeleton";

const styles = StyleSheet.create({
  // Full screen width. Column padding stays on the content so the indicator
  // is drawn on the screen edge rather than inside the column.
  list: { flex: 1 },
});
const messageListPosition = { minIndexForVisible: 0 };
const liveMessageListPosition = { ...messageListPosition, autoscrollToTopThreshold: 80 };
function threadItemKey(item: ThreadItem<MobileMessage>) {
  return item.kind === "voiceChat" ? item.key : item.message.id;
}

/**
 * The chat's messages: the inverted live list, or the pinned page a search jump opened, with the
 * jump to latest button over either.
 */
export function ThreadMessageList({
  scroll,
  pinnedListHandlers,
  threadKey,
  headerClearance,
  bottomInset,
  columnPadding,
  visibleMessages,
  liveItems,
  renderItem,
  renderMessageRow,
  loadEarlierControl,
  failedSendBubbles,
  errorNotice,
  workingFooter,
  initialLoading,
  loadingNewer,
  showLatest,
}: {
  scroll: ThreadListScroll;
  pinnedListHandlers: ReturnType<typeof useThreadPaging>["pinnedListHandlers"];
  threadKey: string | undefined;
  headerClearance: { padding: number; minHeight: number };
  /** Space under the list that the composer does not cover. */
  bottomInset: number;
  /** Message inset. Applied to the content, never the scroll view frame. */
  columnPadding: ThreadColumnPadding;
  visibleMessages: MobileMessage[];
  liveItems: ThreadItem<MobileMessage>[];
  renderItem: ListRenderItem<ThreadItem<MobileMessage>>;
  renderMessageRow: (
    message: MobileMessage,
    options?: { enableJump?: boolean; index?: number },
  ) => ReactElement;
  loadEarlierControl: ReactElement | null;
  failedSendBubbles: ReactNode;
  errorNotice: ReactNode;
  workingFooter: ReactNode;
  initialLoading: boolean;
  loadingNewer: boolean;
  showLatest: () => void;
}) {
  const tokens = mobileTokens();
  const { showPinnedPage, pinnedTarget, pinnedNewerCursor, behavior, state } = scroll;
  const { jumpTarget } = scroll;
  const pinnedMessages = useMemo(
    () => threadWindowMessages(visibleMessages, pinnedNewerCursor),
    [visibleMessages, pinnedNewerCursor],
  );
  // FlatList wraps each row in a cell. Measure the cell, whose y is relative to
  // the content, rather than the message's local y (always zero in its cell).
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;
  const PinnedCell = useMemo(
    () =>
      function PinnedCell({ item, index, onLayout, ...props }: CellRendererProps<MobileMessage>) {
        return (
          <View
            {...props}
            onLayout={(event) => {
              onLayout?.(event);
              scrollRef.current.layoutJumpRow(item.id, event.nativeEvent.layout.y, index);
            }}
          />
        );
      },
    [],
  );
  const retryJump = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const targetId = jumpTarget ?? pinnedTarget?.messageId;
  const jumpToPinnedTarget = useRef(() => {});
  jumpToPinnedTarget.current = () => {
    if (!showPinnedPage || !scroll.isPinnedJumpPending()) return;
    const index = pinnedMessages.findIndex((message) => message.id === targetId);
    if (index < 0) return;
    scroll.pinnedList.current?.scrollToIndex({
      index,
      viewOffset: headerClearance.padding,
      animated: false,
    });
  };
  useEffect(() => {
    jumpToPinnedTarget.current();
    return () => clearTimeout(retryJump.current);
  }, [showPinnedPage, targetId]);
  const listContentStyle = useMemo(
    () => ({
      paddingBottom: headerClearance.padding,
      paddingTop: bottomInset + 16,
      // An inverted Android list mirrors with scale: -1, so asymmetric padding swaps sides.
      paddingStart:
        Platform.OS === "android" ? columnPadding.paddingEnd : columnPadding.paddingStart,
      paddingEnd: Platform.OS === "android" ? columnPadding.paddingStart : columnPadding.paddingEnd,
    }),
    [headerClearance.padding, bottomInset, columnPadding],
  );

  return (
    // The floor keeps a tall suggestion list from sliding under the transparent header.
    <View
      ref={scroll.helperViewport}
      collapsable={false}
      style={{ flex: 1, minHeight: headerClearance.minHeight, position: "relative" }}
    >
      {showPinnedPage ? (
        <ThreadScrollSurface key={`pinned:${jumpTarget ?? pinnedTarget?.messageId ?? threadKey}`}>
          <FlatList
            key={jumpTarget ?? pinnedTarget?.messageId ?? threadKey}
            ref={scroll.pinnedList}
            data={pinnedMessages}
            keyExtractor={(message) => message.id}
            extraData={renderMessageRow}
            CellRendererComponent={PinnedCell}
            renderItem={({ item, index }) => renderMessageRow(item, { index })}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              if (!scroll.isPinnedJumpPending()) return;
              scroll.pinnedList.current?.scrollToOffset({
                offset: Math.max(0, averageItemLength * index - headerClearance.padding),
                animated: false,
              });
              clearTimeout(retryJump.current);
              retryJump.current = setTimeout(() => jumpToPinnedTarget.current(), 100);
            }}
            style={styles.list}
            // A pinned page always shows the floating jump button (44pt, 12pt from the
            // bottom), so its last message must be able to scroll clear of it.
            contentContainerStyle={{
              paddingTop: headerClearance.padding,
              paddingBottom: bottomInset + 12 + 44 + 16,
              ...columnPadding,
            }}
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            maintainVisibleContentPosition={messageListPosition}
            scrollEventThrottle={16}
            {...pinnedListHandlers}
            ListHeaderComponent={loadEarlierControl}
            ListFooterComponent={
              <View>
                {pinnedNewerCursor === null ? failedSendBubbles : null}
                {errorNotice}
                {pinnedNewerCursor === null ? (
                  workingFooter
                ) : loadingNewer ? (
                  <ActivityIndicator
                    color={tokens.mutedForeground}
                    style={{ marginVertical: 12 }}
                  />
                ) : null}
              </View>
            }
          />
        </ThreadScrollSurface>
      ) : (
        <ThreadScrollSurface key={`live:${threadKey}`}>
          <FlatList
            key={threadKey}
            ref={scroll.list}
            data={liveItems}
            inverted
            keyExtractor={threadItemKey}
            // This callback tracks every row input, including reply, reaction and highlight state.
            extraData={renderMessageRow}
            style={styles.list}
            // Swiping down hides the keyboard; on iOS it follows the finger.
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            // Inverted, so the bottom padding is the visual top, clear of the transparent header.
            contentContainerStyle={listContentStyle}
            // Follow changes to the recovery card while already at the newest content.
            maintainVisibleContentPosition={liveMessageListPosition}
            scrollEventThrottle={16}
            {...scroll.liveListHandlers}
            ListFooterComponent={loadEarlierControl}
            ListHeaderComponent={
              <View onLayout={() => scroll.performScroll(behavior.current.onLayout())}>
                {errorNotice}
                {failedSendBubbles}
                {initialLoading ? null : workingFooter}
              </View>
            }
            renderItem={renderItem}
          />
        </ThreadScrollSurface>
      )}
      {initialLoading ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              paddingTop: headerClearance.padding,
              paddingBottom: bottomInset + 16,
              ...columnPadding,
            },
          ]}
        >
          <ThreadMessagesSkeleton />
        </View>
      ) : null}
      {showPinnedPage || state.detached ? (
        <JumpToLatestButton
          bottomInset={bottomInset}
          insetEnd={columnPadding.paddingEnd}
          unread={state.unread}
          onPress={() => {
            if (showPinnedPage) {
              showLatest();
              return;
            }
            scroll.follow(behavior.current.jumpToLatest());
          }}
        />
      ) : null}
    </View>
  );
}
