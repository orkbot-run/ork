// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MenuView } from "@expo/ui/community/menu";
import type { VaultKind, VaultRevealed } from "@orkbot/contracts";
import { isIdentityConfirmationRequired, VAULT_KINDS, vaultKind } from "@orkbot/contracts";
import { useQuery } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { LoadFailure } from "../../components/load-failure";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../../components/settings-group";
import { VaultItemEditor } from "../../components/vault-item-editor";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { ACCOUNT_SETTINGS, captureSettingsContext } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import type { VaultItem, VaultSave } from "../../lib/vault";
import {
  billingChoices,
  readableItem,
  vaultItemSubtitle,
  vaultKindLabel,
  vaultKindSymbol,
} from "../../lib/vault";

export default function OrganizationVaultScreen() {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const sideInsets = useSideInsets();
  const colorScheme = useResolvedAppearance();
  const owner = useMemo(() => captureSettingsContext(ACCOUNT_SETTINGS), []);
  const rpc = owner.send;
  const context = useQuery(
    { ...rpcQuery("organizationVault/context"), queryFn: () => rpc("organizationVault/context") },
    queryClient,
  );
  const shared = context.data?.kind === "shared";
  const items = useQuery(
    {
      ...rpcQuery("organizationVault/list"),
      queryFn: () => rpc("organizationVault/list"),
      enabled: shared,
    },
    queryClient,
  );
  const [accessItem, setAccessItem] = useState<string | null>(null);
  const workspaces = useQuery(
    {
      ...rpcQuery("organizationVault/credentialWorkspaces", { name: accessItem ?? "" }),
      queryFn: () => rpc("organizationVault/credentialWorkspaces", { name: accessItem! }),
      enabled: shared && accessItem !== null,
    },
    queryClient,
  );
  const [editing, setEditing] = useState<{
    kind: VaultKind;
    item?: VaultItem;
    revealed?: VaultRevealed;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        setEditing(null);
        setAccessItem(null);
      };
    }, []),
  );

  async function edit(item: VaultItem) {
    const kind = vaultKind(item.auth.type);
    try {
      setPending(true);
      setError(null);
      const revealed =
        kind === "login" || kind === "card"
          ? await withIdentityConfirmation(() =>
              rpc("organizationVault/reveal", { name: item.name }),
            )
          : undefined;
      if (focused.current && owner.isCurrent()) setEditing({ kind, item, revealed });
    } catch (err) {
      if (owner.isCurrent() && !isIdentityConfirmationRequired(err))
        setError(t("Could not show the item"));
    } finally {
      if (owner.isCurrent()) setPending(false);
    }
  }

  async function save(change: VaultSave) {
    if (!change.value && !editing?.item) throw new Error("A value is required");
    await rpc("organizationVault/put", {
      ...change,
      destination: {
        ...change.destination,
        name: change.destination.name ?? `secret-${randomUUID()}`,
      },
      createOnly: !editing?.item,
    });
    await items.refetch();
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
      >
        {context.isPending ? (
          <ActivityIndicator color={native.secondaryLabel} />
        ) : context.data?.kind === "personal" || context.data?.kind === "unmanaged" ? (
          <Text style={styles.description}>
            {t(
              "Personal organizations use your personal vault. Open Your settings → Vault to manage your secrets.",
            )}
          </Text>
        ) : !shared ? (
          <LoadFailure
            message={t("Could not verify this organization. Sign in again and try again.")}
            onRetry={() => void context.refetch()}
          />
        ) : (
          <>
            <Text style={styles.description}>
              {t(
                "Your organization's server manages these secrets. Ork Accounts does not receive them. Only organization admins can manage this vault.",
              )}
            </Text>
            {items.isError || (accessItem && workspaces.isError) ? (
              <LoadFailure
                message={t(
                  "Could not load the organization vault. Check your access and try again.",
                )}
                onRetry={() => {
                  void items.refetch();
                  void workspaces.refetch();
                }}
              />
            ) : null}
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}
            {items.isSuccess ? (
              <MenuView
                colorScheme={colorScheme}
                title={t("New item")}
                actions={VAULT_KINDS.map((kind) => ({ id: kind, title: vaultKindLabel(kind) }))}
                onPressAction={({ nativeEvent }) =>
                  setEditing({ kind: nativeEvent.event as VaultKind })
                }
              >
                <View
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={t("New item")}
                  style={styles.add}
                >
                  <NativeSymbol ios="plus" android="add" size={18} />
                  <Text style={styles.addText}>{t("New item")}</Text>
                </View>
              </MenuView>
            ) : null}
            {items.data?.length === 0 ? (
              <Text style={styles.description}>{t("Nothing saved yet.")}</Text>
            ) : null}
            <SettingsGroup label={t("Secrets")}>
              {items.data?.map((item) => {
                const readable = readableItem(item);
                const symbol = readable
                  ? vaultKindSymbol(vaultKind(readable.auth.type))
                  : { ios: "questionmark", android: "help" };
                return (
                  <SettingsRow
                    key={item.name}
                    title={item.title || item.name}
                    detail={vaultItemSubtitle(item)}
                    leading={
                      <View style={styles.tile}>
                        <NativeSymbol
                          ios={symbol.ios}
                          android={symbol.android as never}
                          size={17}
                        />
                      </View>
                    }
                    chevron="right"
                    disabled={pending}
                    onPress={() =>
                      Alert.alert(item.title || item.name, undefined, [
                        { text: t("Workspace access"), onPress: () => setAccessItem(item.name) },
                        ...(readable
                          ? [
                              {
                                text: t("Edit"),
                                onPress: () => void edit(readable),
                              },
                            ]
                          : []),
                        {
                          text: t("Remove"),
                          style: "destructive" as const,
                          onPress: () =>
                            Alert.alert(
                              t("Remove {name}?", { name: item.title || item.name }),
                              undefined,
                              [
                                { text: t("Cancel"), style: "cancel" },
                                {
                                  text: t("Remove"),
                                  style: "destructive",
                                  onPress: () => {
                                    setPending(true);
                                    setError(null);
                                    void rpc("organizationVault/remove", { name: item.name })
                                      .then(() => items.refetch())
                                      .catch(() => setError(t("Could not remove the item")))
                                      .finally(() => setPending(false));
                                  },
                                },
                              ],
                            ),
                        },
                        { text: t("Cancel"), style: "cancel" },
                      ])
                    }
                  />
                );
              })}
            </SettingsGroup>
            {accessItem ? (
              <SettingsGroup
                label={
                  t("Workspace access") +
                  ": " +
                  (items.data?.find((item) => item.name === accessItem)?.title || accessItem)
                }
                footer={t("Choose which workspaces can use this secret.")}
              >
                <SettingsRow title={t("Back")} onPress={() => setAccessItem(null)} />
                {workspaces.data?.map((space) => (
                  <SettingsSwitch
                    key={space.id}
                    label={space.name}
                    detail={space.state}
                    value={space.granted}
                    disabled={pending}
                    onChange={(allowed) => {
                      setPending(true);
                      setError(null);
                      void rpc("organizationVault/setCredentialWorkspaceAccess", {
                        name: accessItem,
                        spaceId: space.id,
                        allowed,
                      })
                        .then(() => workspaces.refetch())
                        .catch(() => setError(t("Could not change workspace access.")))
                        .finally(() => setPending(false));
                    }}
                  />
                ))}
              </SettingsGroup>
            ) : null}
          </>
        )}
      </ScrollView>
      {editing ? (
        <VaultItemEditor
          kind={editing.kind}
          item={editing.item}
          revealed={editing.revealed}
          contacts={billingChoices(items.data ?? [])}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
      {identityDialog}
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 20 },
    description: { color: native.secondaryLabel, fontSize: 14, lineHeight: 20 },
    error: { color: tokens.destructive, fontSize: 14 },
    add: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-start",
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: native.groupedCell,
    },
    addText: { color: native.label, fontSize: 15 },
    tile: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.groupedCell,
    },
  });
}
