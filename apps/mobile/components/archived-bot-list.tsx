import { MenuView } from "@expo/ui/community/menu";
import { typeScale } from "@orkbot/ui-tokens";
import { FlatList, Pressable, Text, View } from "react-native";
import type { MobileBot, MobileGroup } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useResolvedAppearance } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { LongPressMenu } from "./long-press-menu";
import { NativeSymbol } from "./native-symbol";
import { Chevron } from "./row-accessories";

export type ArchivedBotListProps = {
  bots: MobileBot[];
  groups: MobileGroup[];
  pending: boolean;
  onOpen: (bot: MobileBot) => void;
  onRestore: (bot: MobileBot) => void;
  onDelete: (bot: MobileBot) => void;
  onRestoreGroup: (group: MobileGroup) => void;
};

export function ArchivedBotList({
  bots,
  groups,
  pending,
  onOpen,
  onRestore,
  onDelete,
  onRestoreGroup,
}: ArchivedBotListProps) {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const scheme = useResolvedAppearance();
  return (
    <FlatList<{ kind: "bot"; bot: MobileBot } | { kind: "group"; group: MobileGroup }>
      data={[
        ...bots.map((bot) => ({ kind: "bot" as const, bot })),
        ...groups.map((group) => ({ kind: "group" as const, group })),
      ]}
      keyExtractor={(item) =>
        item.kind === "bot" ? `bot:${item.bot.id}` : `group:${item.group.id}`
      }
      extraData={{ pending, scheme, onOpen, onRestore, onDelete, onRestoreGroup }}
      style={sideInsets}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20 }}
      renderItem={({ item, index }) => {
        const corners = {
          backgroundColor: native.fill,
          overflow: "hidden" as const,
          borderTopLeftRadius: index === 0 ? 14 : 0,
          borderTopRightRadius: index === 0 ? 14 : 0,
          borderBottomLeftRadius: index === bots.length + groups.length - 1 ? 14 : 0,
          borderBottomRightRadius: index === bots.length + groups.length - 1 ? 14 : 0,
        };
        if (item.kind === "bot") {
          const bot = item.bot;
          return (
            <View style={corners}>
              <LongPressMenu
                key={bot.id}
                colorScheme={scheme}
                actions={[
                  { id: "restore", title: t("Restore"), attributes: { disabled: pending } },
                  {
                    id: "delete",
                    title: t("Delete"),
                    attributes: { destructive: true, disabled: pending },
                  },
                ]}
                onPressAction={({ nativeEvent }) =>
                  nativeEvent.event === "restore" ? onRestore(bot) : onDelete(bot)
                }
              >
                {(onLongPress) => (
                  <Pressable
                    disabled={pending}
                    onPress={() => onOpen(bot)}
                    onLongPress={onLongPress}
                    accessibilityRole="button"
                    style={{
                      minHeight: 54,
                      paddingHorizontal: 16,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>
                      {bot.name}
                    </Text>
                    <Chevron />
                  </Pressable>
                )}
              </LongPressMenu>
            </View>
          );
        }
        const group = item.group;
        return (
          <View style={corners}>
            <MenuView
              key={`group-${group.id}`}
              colorScheme={scheme}
              actions={[{ id: "restore", title: t("Restore"), attributes: { disabled: pending } }]}
              onPressAction={() => onRestoreGroup(group)}
            >
              <View
                accessible
                accessibilityLabel={`${group.name}, ${t("Group")}`}
                style={{
                  minHeight: 54,
                  paddingHorizontal: 16,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <NativeSymbol
                  ios="person.2"
                  android="people-outline"
                  color={native.secondaryLabel}
                />
                <Text style={{ flex: 1, color: native.label, ...typeScale.cardTitle }}>
                  {group.name}
                </Text>
              </View>
            </MenuView>
          </View>
        );
      }}
    />
  );
}
