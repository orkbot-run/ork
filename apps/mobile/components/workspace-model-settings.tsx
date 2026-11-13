// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelCatalogEntry } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { MenuPickerMenu } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

/** The captured RPC context keeps edits bound to the originating server and workspace. */
export function WorkspaceModelSettings({
  value,
  catalog,
  send,
  isCurrent,
  onChanged,
}: {
  value: { canManage: boolean; policy: { provider: string; modelId: string } | null };
  catalog: ModelCatalogEntry[];
  send: typeof rpc;
  isCurrent: () => boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const providers = [
    ...new Map(
      catalog
        .filter((entry) => entry.auth !== "oauth" && entry.protocol !== "decisions")
        .map((entry) => [entry.provider, entry]),
    ).values(),
  ];
  const fields =
    providers.find((entry) => entry.provider === provider)?.connection?.routingFields ?? [];
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  function open() {
    setProvider(value.policy?.provider ?? providers[0]?.provider ?? "");
    setModelId(value.policy?.modelId ?? "");
    setApiKey("");
    setBaseUrl("");
    setRouting({});
    setError(null);
    setEditing(true);
  }
  async function save(clear: boolean) {
    if (busy || !isCurrent()) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (clear)
        await send("models/clearWorkspacePolicy", undefined, { signal: controller.signal });
      else
        await send(
          "models/setWorkspacePolicy",
          {
            provider,
            modelId: modelId.trim(),
            apiKey: apiKey.trim(),
            credentialId: null,
            ...(compatible ? { baseUrl: baseUrl.trim() } : {}),
            ...(fields.length ? { routing } : {}),
          },
          { signal: controller.signal },
        );
      if (!controller.signal.aborted && isCurrent()) {
        setApiKey("");
        setEditing(false);
        await onChanged();
      }
    } catch {
      if (!controller.signal.aborted && isCurrent()) setError(t("Could not save"));
    } finally {
      if (!controller.signal.aborted && isCurrent()) setBusy(false);
    }
  }
  if (!value.policy && !value.canManage) return null;
  return (
    <View style={{ gap: 12 }}>
      <SettingsGroup label={t("Workspace model")}>
        {value.policy ? (
          <SettingsRow title={value.policy.modelId} detail={value.policy.provider} />
        ) : null}
        {value.canManage && !editing ? (
          <SettingsRow title={t("Set workspace model")} onPress={open} accessibilityRole="button" />
        ) : null}
      </SettingsGroup>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {error}
        </Text>
      ) : null}
      {value.canManage && editing ? (
        <SettingsGroup>
          <MenuPickerMenu
            label={t("Provider")}
            choices={providers.map((entry) => ({
              key: entry.provider,
              label: entry.providerName ?? entry.provider,
            }))}
            value={provider}
            disabled={busy}
            onChange={(next) => {
              setProvider(next);
              setModelId("");
              setApiKey("");
              setRouting({});
            }}
          >
            <View>
              <SettingsRow
                title={t("Provider")}
                value={
                  providers.find((entry) => entry.provider === provider)?.providerName ?? provider
                }
                chevron="down"
              />
            </View>
          </MenuPickerMenu>
          <SettingsInputRow
            accessibilityLabel={t("Model")}
            placeholder={t("Model")}
            value={modelId}
            onChangeText={setModelId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          {compatible ? (
            <SettingsInputRow
              accessibilityLabel={t("API URL")}
              placeholder={t("API URL")}
              value={baseUrl}
              onChangeText={setBaseUrl}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
          ) : null}
          {fields.map((field) => (
            <SettingsInputRow
              key={field.key}
              accessibilityLabel={field.label}
              placeholder={field.label}
              value={routing[field.key] ?? ""}
              onChangeText={(text) => setRouting({ ...routing, [field.key]: text })}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ))}
          <SettingsInputRow
            accessibilityLabel={t("API key")}
            placeholder={t("API key")}
            value={apiKey}
            onChangeText={setApiKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            editable={!busy}
          />
          <SettingsRow
            title={t("Save")}
            accessibilityRole="button"
            disabled={
              busy ||
              !provider ||
              !modelId.trim() ||
              !apiKey.trim() ||
              (compatible && !baseUrl.trim()) ||
              fields.some((field) => field.required && !routing[field.key]?.trim())
            }
            onPress={() => void save(false)}
          />
          <SettingsRow
            title={t("Cancel")}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => {
              setApiKey("");
              setEditing(false);
            }}
          />
        </SettingsGroup>
      ) : null}
      {value.canManage && value.policy && !editing ? (
        <NativeActionButton
          label={t("Remove")}
          prominence="destructive"
          variant="text"
          disabled={busy}
          onPress={() =>
            Alert.alert(
              t("Remove the workspace model?"),
              t("Members will need their own model connection again."),
              [
                { text: t("Cancel"), style: "cancel" },
                { text: t("Remove"), style: "destructive", onPress: () => void save(true) },
              ],
            )
          }
        />
      ) : null}
    </View>
  );
}
