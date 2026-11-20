// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited settings are preserved; the Accounts dashboard link is an Ork addition.

import { organizationDashboardUrl } from "@orkbot/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { currentApiBase, rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { installationRevocationScope } from "../../lib/installation-transport";
import { native, useThemedStyles } from "../../lib/native";
import {
  activeOrganization,
  leaveDeletedOrganization,
  refreshOrganizations,
  useOrganizations,
} from "../../lib/organizations";
import { queryClient, rpcQuery } from "../../lib/query";
import { openFromSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

export default function OrganizationSettings() {
  const { t } = useI18n();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const query = useOrganizations();
  const modelPolicy = useQuery(rpcQuery("models/workspacePolicy"), queryClient);
  const organization = activeOrganization(query.data);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (modelPolicy.isPending || modelPolicy.isError) {
    return (
      <SafeAreaView edges={["bottom"]} style={styles.screen}>
        <ScrollView style={sideInsets} contentContainerStyle={styles.content}>
          {modelPolicy.isError ? (
            <LoadFailure
              message={t("Could not load organization settings.")}
              onRetry={() => void modelPolicy.refetch()}
            />
          ) : (
            <ActivityIndicator color={native.secondaryLabel} />
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (modelPolicy.data?.managed) {
    const target = installationRevocationScope(currentApiBase())?.target;
    return (
      <SafeAreaView edges={["bottom"]} style={styles.screen}>
        <ScrollView style={sideInsets} contentContainerStyle={styles.content}>
          <Text style={{ color: native.secondaryLabel }}>
            {t("Manage your organization, servers and people in Ork Accounts.")}
          </Text>
          {error ? (
            <Text accessibilityRole="alert" style={{ color: native.secondaryLabel }}>
              {error}
            </Text>
          ) : null}
          <SettingsGroup>
            <SettingsRow
              title={t("Open Ork Accounts")}
              chevron="right"
              onPress={() => {
                setError(null);
                void Linking.openURL(organizationDashboardUrl(target?.organizationId)).catch(() =>
                  setError(t("Could not open Ork Accounts. Try again.")),
                );
              }}
            />
            <SettingsRow
              title={t("Organization models")}
              chevron="right"
              onPress={() => openFromSettingsSheet(router, "/models?organization=1")}
            />
            <SettingsRow
              title={t("Organization vault")}
              chevron="right"
              onPress={() => openFromSettingsSheet(router, "/organization-vault")}
            />
          </SettingsGroup>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!organization) {
    return (
      <SafeAreaView edges={["bottom"]} style={styles.screen}>
        <ScrollView style={sideInsets} contentContainerStyle={styles.content}>
          {query.error ? (
            <LoadFailure message={errorText(query.error)} onRetry={() => void query.refetch()} />
          ) : (
            <ActivityIndicator color={native.secondaryLabel} />
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }
  const current = organization;
  const name = draft ?? current.name;
  const canDelete =
    current.canManage &&
    (query.data?.organizations.filter((each) => each.canManage).length ?? 0) > 1;

  async function rename() {
    const next = name.trim();
    if (!next || next === current.name || pending) {
      setDraft(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc("organizations/rename", { organizationId: current.id, name: next });
      await refreshOrganizations();
      setDraft(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (confirmation.trim() !== current.name.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const { activeSpaceId } = await rpc("organizations/remove", { organizationId: current.id });
      await leaveDeletedOrganization(current, activeSpaceId);
    } catch (err) {
      setError(errorText(err));
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <SettingsGroup accessibilityLabel={t("Name")} label={t("Name")}>
          {current.canManage ? (
            <SettingsInputRow
              key="name"
              accessibilityLabel={t("Name")}
              editable={!pending}
              maxLength={60}
              value={name}
              onChangeText={setDraft}
              onEndEditing={() => void rename()}
              returnKeyType="done"
            />
          ) : (
            <SettingsRow key="name" title={current.name} />
          )}
        </SettingsGroup>
        <SettingsGroup>
          <SettingsRow
            key="create"
            accessibilityRole="button"
            disabled={pending}
            title={t("Create organization")}
            onPress={() => openFromSettingsSheet(router, "/new-organization")}
          />
        </SettingsGroup>
        {canDelete ? (
          <SettingsGroup>
            <SettingsRow
              key="delete"
              accessibilityRole="button"
              destructive
              disabled={pending}
              dimmed={pending}
              title={t("Delete organization")}
              onPress={() => {
                setConfirming((open) => !open);
                setConfirmation("");
              }}
            />
            {confirming ? (
              <SettingsInputRow
                key="confirmation"
                accessibilityLabel={t("Type {name} to confirm", { name: current.name })}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!pending}
                placeholder={t("Type {name} to confirm", { name: current.name })}
                value={confirmation}
                onChangeText={setConfirmation}
              />
            ) : null}
            {confirming ? (
              <SettingsRow
                key="confirm"
                accessibilityRole="button"
                destructive
                disabled={pending || confirmation.trim() !== current.name.trim()}
                dimmed={pending || confirmation.trim() !== current.name.trim()}
                title={t("Delete")}
                trailing={
                  pending ? <ActivityIndicator color={mobileTokens().destructive} /> : undefined
                }
                onPress={() => void remove()}
              />
            ) : null}
          </SettingsGroup>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 24, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
