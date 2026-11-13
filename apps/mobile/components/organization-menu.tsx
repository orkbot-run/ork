// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 organization menus are preserved; managed workspace selection follows LICENSE.md.

import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { OrganizationList } from "@orkbot/contracts";
import { typeScale } from "@orkbot/ui-tokens";
import { Alert, StyleSheet, Text, View } from "react-native";
import { resolveMobileAppearance } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import {
  activeOrganization,
  organizationForAction,
  organizationSwitchActions,
  switchOrganization,
} from "../lib/organizations";
import { useWorkspacePicker } from "../lib/workspace-picker";
import { NativeSymbol } from "./native-symbol";

/** Switches to the organization row picked from a menu. */
export function useOrganizationMenuAction(list: OrganizationList | undefined) {
  const { t } = useI18n();
  return (action: string) => {
    const target = organizationForAction(list, action);
    if (!target || !list) return;
    void switchOrganization(target, list.organizations).then((switched) => {
      if (!switched) Alert.alert(t("Could not switch spaces"), t("Try again."));
    });
  };
}

/** The inbox title once there is a second organization: the active one's name, opening a switcher. */
export function OrganizationTitleMenu({ list }: { list: OrganizationList | undefined }) {
  const styles = useThemedStyles(createStyles);
  const onAction = useOrganizationMenuAction(list);
  const picker = useWorkspacePicker();
  const { t } = useI18n();
  const actions: MenuAction[] = picker
    ? [{ id: "workspace", title: t("Workspace") }]
    : organizationSwitchActions(list);
  const active = activeOrganization(list);
  const name = picker?.organization ?? active?.name;
  if (actions.length === 0 || !name) return null;
  return (
    <MenuView
      actions={actions}
      colorScheme={resolveMobileAppearance()}
      style={styles.anchor}
      onPressAction={({ nativeEvent }) =>
        picker && nativeEvent.event === "workspace" ? picker.open() : onAction(nativeEvent.event)
      }
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={name}
        testID="organization-menu"
        style={styles.title}
      >
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
        <NativeSymbol
          ios="chevron.down"
          android="chevron-down"
          size={12}
          weight="semibold"
          color={native.secondaryLabel}
        />
      </View>
    </MenuView>
  );
}

function createStyles() {
  return StyleSheet.create({
    anchor: { flexShrink: 1, minWidth: 0 },
    title: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: 220,
      flexShrink: 1,
      minHeight: 44,
      paddingHorizontal: 8,
    },
    name: {
      color: native.label,
      ...typeScale.body,
      fontWeight: "600",
      flexShrink: 1,
    },
  });
}
