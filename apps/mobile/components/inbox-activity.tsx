// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved. Personal Ork changes follow LICENSE.md.

import type { RunActivityRow } from "@orkbot/contracts";
import type { SnoozePreset } from "@orkbot/core";
import { activitySections, threadSnoozeState } from "@orkbot/core";
import type { Href } from "expo-router";
import type { ReactElement, ReactNode } from "react";
import { cloneElement, useMemo } from "react";
import { View } from "react-native";
import { activityPreview, activityStatusLabel, formatActivityRelativeTime } from "../lib/activity";
import type { MobileBot, MobileBotSection, MobileGroup } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { InboxChatKind, InboxRowAction } from "../lib/inbox-swipe";
import { inboxRowActionList } from "../lib/inbox-swipe";
import { useThemedStyles } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import type { BotOrganizationUpdate } from "./bot-organize-modal";
import { GroupAvatar } from "./group-avatar";
import { createHomeStyles } from "./home-styles";
import { ConversationRow, FALLBACK_COLOR, SectionToggle } from "./inbox-rows";
import { InboxSwipeRow } from "./inbox-swipe-row";

export function ActivitySection({
  activity,
  bots,
  groups,
  toggledSections,
  onToggleSection,
  openChat,
  botAction,
  groupAction,
  sections: botSections = [],
  organizeFromMenu,
  editSectionFromMenu,
  snoozeFromMenu,
}: {
  activity: { active: RunActivityRow[]; recent: RunActivityRow[] };
  bots: MobileBot[];
  groups: MobileGroup[];
  /** Section keys flipped from their default fold, stored with the inbox's collapsed sections. */
  toggledSections: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  openChat: (href: Href) => void;
  botAction?: (action: InboxRowAction, bot: MobileBot) => void;
  groupAction?: (action: InboxRowAction, group: MobileGroup) => void;
  sections?: MobileBotSection[];
  organizeFromMenu?: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup,
    update: BotOrganizationUpdate,
  ) => void;
  editSectionFromMenu?: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup,
    mode: "create" | "rename",
  ) => void;
  snoozeFromMenu?: (
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup,
    preset: SnoozePreset,
  ) => void;
}) {
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const sections = activitySections({ ...activity, bots, groups });
  function withActions(
    row: ReactElement<{
      actions?: InboxRowAction[];
      onAction?: (action: InboxRowAction) => void;
      woken?: boolean;
    }>,
    kind: InboxChatKind,
    chat: MobileBot | MobileGroup,
    key: string,
  ) {
    const action = kind === "bot" ? botAction : groupAction;
    if (!action || !organizeFromMenu || !editSectionFromMenu) return row;
    const perform = (item: InboxRowAction) =>
      kind === "bot"
        ? botAction?.(item, chat as MobileBot)
        : groupAction?.(item, chat as MobileGroup);
    return (
      <InboxSwipeRow
        key={key}
        rowKey={`activity:${kind}:${chat.id}`}
        unread={chat.unread}
        pinned={chat.pinned}
        notifyOnFinish={kind === "bot" ? (chat as MobileBot).notifyOnFinish : undefined}
        sectionId={chat.sectionId}
        sections={botSections}
        preview={{
          title: chat.name,
          message: chat.preview,
          avatar:
            kind === "bot" ? (
              <BotAvatar
                identity={chat.id}
                color={(chat as MobileBot).color}
                avatarSet={(chat as MobileBot).avatarSet}
                size={32}
              />
            ) : (
              <GroupAvatar members={(chat as MobileGroup).members} size={32} />
            ),
        }}
        onAction={perform}
        onSnooze={snoozeFromMenu ? (preset) => snoozeFromMenu(kind, chat, preset) : undefined}
        onOrganize={(update) => organizeFromMenu(kind, chat, update)}
        onEditSection={(mode) => editSectionFromMenu(kind, chat, mode)}
      >
        {cloneElement(row, {
          actions: inboxRowActionList(chat),
          onAction: perform,
          woken: threadSnoozeState(chat.snoozedUntil) === "woken",
        })}
      </InboxSwipeRow>
    );
  }
  const openRun = (run: RunActivityRow) => {
    if (run.groupId) {
      openChat({
        pathname: "/group-thread",
        params: { groupId: run.groupId, name: run.groupName ?? t("Group") },
      });
      return;
    }
    openChat({ pathname: "/thread", params: { botId: run.botId, name: run.botName } });
  };
  const runRows = (runs: RunActivityRow[], detailed = false) =>
    runs.map((run) => {
      const chat = run.groupId ? groupsById.get(run.groupId) : botsById.get(run.botId);
      const row = (
        <ActivityRow
          key={run.runId}
          run={run}
          bot={botsById.get(run.botId)}
          detailed={detailed}
          onPress={() => openRun(run)}
        />
      );
      if (!chat) return row;
      const kind = run.groupId ? "group" : "bot";
      return withActions(row, kind, chat, run.runId);
    });
  const fold = (key: string, title: string, count: number, defaultOpen: boolean) => ({
    title,
    count,
    open: defaultOpen !== toggledSections.has(`activity:${key}`),
    onToggle: () => onToggleSection(`activity:${key}`),
  });
  const unreadCount = sections.unreadGroups.length + sections.unreadBots.length;

  if (
    sections.attention.length + sections.working.length + unreadCount + sections.recent.length ===
    0
  )
    return null;
  return (
    <View style={styles.activitySection}>
      {sections.attention.length > 0 ? (
        <Fold {...fold("attention", t("Needs attention"), sections.attention.length, true)}>
          {runRows(sections.attention)}
        </Fold>
      ) : null}
      {sections.working.length > 0 ? (
        <Fold {...fold("working", t("Working"), sections.working.length, false)}>
          {runRows(sections.working)}
        </Fold>
      ) : null}
      {unreadCount > 0 ? (
        <Fold {...fold("unread", t("Unread"), unreadCount, false)}>
          {sections.unreadGroups.map((group) =>
            withActions(
              <ConversationRow
                key={group.id}
                title={group.name}
                preview={group.preview}
                time={formatActivityRelativeTime(group.updatedAt)}
                accessibilityLabel={group.name}
                onPress={() =>
                  openChat({
                    pathname: "/group-thread",
                    params: { groupId: group.id, name: group.name },
                  })
                }
                avatar={<GroupAvatar members={group.members} />}
              />,
              "group",
              group,
              `unread:${group.id}`,
            ),
          )}
          {sections.unreadBots.map((bot) =>
            withActions(
              <ConversationRow
                key={bot.id}
                title={bot.name}
                preview={bot.preview}
                time={formatActivityRelativeTime(bot.updatedAt)}
                accessibilityLabel={bot.name}
                onPress={() =>
                  openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } })
                }
                avatar={
                  <BotAvatar
                    identity={bot.id}
                    avatarSeed={bot.avatarSeed}
                    color={bot.color}
                    avatarSet={bot.avatarSet}
                    motion="lazy"
                  />
                }
              />,
              "bot",
              bot,
              `unread:${bot.id}`,
            ),
          )}
        </Fold>
      ) : null}
      {sections.recent.length > 0 ? (
        <Fold {...fold("recent", t("Recent"), sections.recent.length, true)}>
          {runRows(sections.recent, true)}
        </Fold>
      ) : null}
    </View>
  );
}

function Fold({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createHomeStyles);
  return (
    <View>
      <View style={styles.sectionHeadingRow}>
        <SectionToggle title={title} count={count} collapsed={!open} onPress={onToggle} />
      </View>
      {open ? children : null}
    </View>
  );
}

function ActivityRow({
  run,
  bot,
  detailed,
  onPress,
  actions,
  onAction,
  woken,
}: {
  run: RunActivityRow;
  bot?: MobileBot;
  /** Recent mixes outcomes, so its rows say how each run ended and when. */
  detailed: boolean;
  onPress: () => void;
  actions?: InboxRowAction[];
  onAction?: (action: InboxRowAction) => void;
  woken?: boolean;
}) {
  const status = activityStatusLabel(run.status);
  const snippet = activityPreview(run);
  const preview = detailed ? (snippet ? `${status}: ${snippet}` : status) : snippet;
  // Compact rows hide tags, so the group stays in the title.
  const title = [run.botName, run.groupName].filter(Boolean).join(", ");
  return (
    <ConversationRow
      title={title}
      preview={preview}
      time={detailed ? formatActivityRelativeTime(run.updatedAt) : ""}
      accessibilityLabel={`${title}, ${status}`}
      onPress={onPress}
      actions={actions}
      onAction={onAction}
      woken={woken}
      avatar={
        <BotAvatar
          identity={run.botId}
          color={bot?.color ?? FALLBACK_COLOR}
          avatarSet={bot?.avatarSet}
          status={run.status}
          motion="lazy"
        />
      }
    />
  );
}
