import { Alert } from "react-native";
import type { ApiRequestContext } from "./api";
import { rpc } from "./api";
import { notifyArchivedChatsChanged } from "./archived-chats";
import { notifyConversationCleared } from "./conversation-cleared";
import { t } from "./i18n";
import { removeFromSearchInbox } from "./search-inbox";
import { errorText } from "./user-error";

export function confirmDeleteBot(
  bot: { id: string; name: string },
  onDeleted: () => void,
  // False once the screen that asked has gone, so a late failure doesn't alert elsewhere.
  current: () => boolean = () => true,
  requestContext?: ApiRequestContext,
  onDeletedAfterLeaving?: () => void,
) {
  const remove = async (deleteMemories: boolean) => {
    if (!current()) return;
    try {
      if (requestContext) {
        await rpc(
          "bots/remove",
          { botId: bot.id, deleteMemories },
          { requestContext, skipSpaceAuthRecovery: true },
        );
      } else {
        await rpc("bots/remove", { botId: bot.id, deleteMemories });
      }
      if (current()) {
        removeFromSearchInbox(bot.id);
        onDeleted();
      } else {
        onDeletedAfterLeaving?.();
      }
    } catch (error) {
      if (current()) Alert.alert(t("Could not delete bot"), errorText(error, t("Try again.")));
    }
  };

  Alert.alert(
    t("Delete {name}?", { name: bot.name }),
    t(
      "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Keep memories"), style: "destructive", onPress: () => void remove(false) },
      {
        text: t("Delete memories too"),
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}

export function confirmDeleteGroup(
  group: { id: string; name: string },
  onDeleted: () => void,
  requestContext?: ApiRequestContext,
  current: () => boolean = () => true,
) {
  Alert.alert(t("Delete {name}?", { name: group.name }), t("Bots and their own chats stay."), [
    { text: t("Cancel"), style: "cancel" },
    {
      text: t("Delete"),
      style: "destructive",
      onPress: () => {
        if (!current()) return;
        void (
          requestContext
            ? rpc(
                "groups/remove",
                { groupId: group.id },
                { requestContext, skipSpaceAuthRecovery: true },
              )
            : rpc("groups/remove", { groupId: group.id })
        )
          .then(() => {
            if (current()) {
              removeFromSearchInbox(group.id);
              onDeleted();
            }
          })
          .catch((err) => {
            if (current())
              Alert.alert(t("Could not delete group"), errorText(err, t("Try again.")));
          });
      },
    },
  ]);
}

export async function restoreArchivedBot(botId: string): Promise<void> {
  await rpc("bots/restore", { botId });
}

export async function archiveBot(botId: string): Promise<void> {
  await rpc("bots/archive", { botId });
  removeFromSearchInbox(botId);
  notifyArchivedChatsChanged();
}

export function confirmClearConversation(botId: string) {
  Alert.alert(
    t("Clear conversation?"),
    t(
      "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Clear"),
        style: "destructive",
        onPress: () =>
          void rpc("threads/clear", { botId })
            .then(() => notifyConversationCleared(botId))
            .catch((error: unknown) =>
              Alert.alert(t("Could not clear conversation"), errorText(error, t("Try again."))),
            ),
      },
    ],
  );
}
