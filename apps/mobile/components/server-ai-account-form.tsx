// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelCatalogEntry, RpcOutput } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { formatAIBudget, parseAIBudget, ServerAIOAuthAttempt } from "@orkbot/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import type { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { MenuPickerMenu } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

export function ServerAIAccountForm({
  account,
  catalog,
  send,
  isCurrent,
  onSaved,
  onCancel,
}: {
  account?: RpcOutput<"serverAI/status">["accounts"][number];
  catalog: ModelCatalogEntry[];
  send: typeof rpc;
  isCurrent(): boolean;
  onSaved(): Promise<unknown>;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const providers = [
    ...new Map(
      catalog.filter((row) => row.protocol !== "decisions").map((row) => [row.provider, row]),
    ).values(),
  ];
  const [provider, setProvider] = useState(account?.provider ?? providers[0]?.provider ?? "");
  const [label, setLabel] = useState(account?.label ?? "");
  const [models, setModels] = useState(account?.models.join("\n") ?? "");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [budget, setBudget] = useState(formatAIBudget(account?.monthlyBudgetMicros ?? null));
  const [concurrency, setConcurrency] = useState(String(account?.concurrencyLimit ?? 8));
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [oauthLogin, setOAuthLogin] = useState<RpcOutput<"serverAI/beginOAuth"> | null>(null);
  const [oauthPending, setOAuthPending] = useState(false);
  const [code, setCode] = useState("");
  const callbacks = useRef({ onSaved, isCurrent });
  callbacks.current = { onSaved, isCurrent };
  const oauth = useMemo(
    () =>
      new ServerAIOAuthAttempt({
        api: {
          beginOAuth: (input, options) => send("serverAI/beginOAuth", input, options),
          completeOAuth: (input, options) => send("serverAI/completeOAuth", input, options),
          finishOAuth: (input, options) => send("serverAI/finishOAuth", input, options),
          submitOAuthCode: (input, options) => send("serverAI/submitOAuthCode", input, options),
          cancelOAuth: (input, options) => send("serverAI/cancelOAuth", input, options),
        },
        isCurrent: () => callbacks.current.isCurrent(),
        open: (url) => Linking.openURL(url),
        onState: (login, pending) => {
          setOAuthLogin(login);
          setOAuthPending(pending);
          setCode("");
        },
        onError: (message) =>
          setError(
            message === "Connected, but could not refresh."
              ? t("Connected, but could not refresh")
              : t("Could not finish sign-in"),
          ),
        onSaved: async () => {
          setKey("");
          await callbacks.current.onSaved();
        },
      }),
    [send, isCurrent],
  );
  useEffect(() => () => oauth.cancel(false), [oauth]);
  const locked = busy || oauthPending;
  const selected = providers.find((row) => row.provider === provider);
  const supportsOAuth = selected?.auth === "oauth" || selected?.auth === "both";
  async function signIn() {
    if (pending.current || oauth.active || !isCurrent()) return;
    setError(null);
    try {
      const limit = Number(concurrency);
      if (!/^\d+$/.test(concurrency) || !Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new Error("Invalid concurrency limit");
      await oauth.start({
        provider,
        connectionId: account?.id ?? null,
        label: label.trim(),
        models: [
          ...new Set(
            models
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ],
        concurrencyLimit: limit,
        monthlyBudgetMicros: parseAIBudget(budget),
      });
    } catch {
      setError(t("Could not save"));
    }
  }
  const fields =
    providers.find((row) => row.provider === provider)?.connection?.routingFields ?? [];
  async function save() {
    if (pending.current || oauth.active || !isCurrent() || (!account && selected?.auth === "oauth"))
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const allowed = [
        ...new Set(
          models
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      const limit = Number(concurrency);
      if (!/^\d+$/.test(concurrency) || !Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new Error("Invalid concurrency limit");
      const settings = {
        label: label.trim(),
        models: allowed,
        concurrencyLimit: limit,
        monthlyBudgetMicros: parseAIBudget(budget),
      };
      const connection = {
        provider,
        modelId: allowed[0],
        apiKey: key.trim(),
        credentialId: null,
        ...(provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { baseUrl: url.trim(), enabledModelIds: allowed }
          : {}),
        ...(fields.length ? { routing } : {}),
      };
      if (account) {
        if (key.trim() || (provider === OPENAI_COMPATIBLE_PROVIDER_ID && url.trim()))
          await send(
            "serverAI/reconnect",
            { connectionId: account.id, connection },
            { signal: controller.signal },
          );
        if (!isCurrent() || controller.signal.aborted) return;
        await send(
          "serverAI/update",
          { connectionId: account.id, ...settings },
          { signal: controller.signal },
        );
      } else
        await send("serverAI/create", { ...settings, connection }, { signal: controller.signal });
      if (!isCurrent() || controller.signal.aborted) return;
      setKey("");
      await onSaved();
    } catch {
      if (isCurrent() && !controller.signal.aborted) setError(t("Could not save"));
    } finally {
      pending.current = null;
      if (isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <SettingsGroup label={account ? t("Edit AI account") : t("Add AI account")}>
        <SettingsInputRow
          testID="server-ai-account-name"
          accessibilityLabel={t("Name")}
          placeholder={t("Name")}
          value={label}
          onChangeText={setLabel}
          editable={!locked}
        />
        <MenuPickerMenu
          label={t("Provider")}
          choices={providers.map((row) => ({
            key: row.provider,
            label: row.providerName ?? row.provider,
          }))}
          value={provider}
          disabled={locked || !!account}
          onChange={(value) => {
            setProvider(value);
            setModels("");
            setKey("");
            setRouting({});
          }}
        >
          <View>
            <SettingsRow
              title={t("Provider")}
              value={providers.find((row) => row.provider === provider)?.providerName ?? provider}
              chevron="down"
            />
          </View>
        </MenuPickerMenu>
        <SettingsInputRow
          testID="server-ai-account-models"
          accessibilityLabel={t("Models")}
          placeholder={t("Models")}
          multiline
          value={models}
          onChangeText={setModels}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!locked}
        />
        {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
          <SettingsInputRow
            accessibilityLabel={t("API URL")}
            placeholder={t("API URL")}
            value={url}
            onChangeText={setUrl}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!locked}
          />
        ) : null}
        {fields.map((field) => (
          <SettingsInputRow
            key={field.key}
            accessibilityLabel={field.label}
            placeholder={field.label}
            value={routing[field.key] ?? ""}
            onChangeText={(value) =>
              setRouting((previous) => ({ ...previous, [field.key]: value }))
            }
            autoCapitalize="none"
            autoCorrect={false}
            editable={!locked}
          />
        ))}
        <SettingsInputRow
          testID="server-ai-account-key"
          accessibilityLabel={t("API key")}
          placeholder={t("API key")}
          value={key}
          onChangeText={setKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!locked}
        />
        <SettingsInputRow
          accessibilityLabel={t("Concurrent requests")}
          placeholder={t("Concurrent requests")}
          value={concurrency}
          onChangeText={setConcurrency}
          keyboardType="number-pad"
          editable={!locked}
        />
        <SettingsInputRow
          accessibilityLabel={t("Monthly budget (USD)")}
          placeholder={t("Monthly budget (USD)")}
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
          editable={!locked}
        />
      </SettingsGroup>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {error}
        </Text>
      ) : null}
      {oauthLogin ? (
        <SettingsGroup label={t("Sign in")}>
          <SettingsRow
            title={t("Open sign-in page")}
            onPress={() => void Linking.openURL(oauthLogin.verificationUri)}
          />
          {oauthLogin.mode !== "auth-url" ? (
            <SettingsRow title={t("Verification code")} value={oauthLogin.userCode} />
          ) : null}
          {oauthLogin.mode === "auth-url" ? (
            <SettingsInputRow
              accessibilityLabel={t("Verification code")}
              placeholder={t("Verification code")}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
          ) : null}
        </SettingsGroup>
      ) : null}
      {oauthLogin?.mode === "auth-url" ? (
        <NativeActionButton
          label={t("Complete sign-in")}
          disabled={!code.trim()}
          onPress={() => void oauth.submit(code)}
        />
      ) : null}
      {supportsOAuth && !oauthPending ? (
        <NativeActionButton
          label={t("Sign in")}
          disabled={busy || !label.trim() || !models.trim()}
          onPress={() => void signIn()}
        />
      ) : null}
      {account || selected?.auth !== "oauth" ? (
        <NativeActionButton
          label={t("Save")}
          busy={busy}
          disabled={!label.trim() || !models.trim() || !provider}
          onPress={() => void save()}
        />
      ) : null}
      <NativeActionButton
        label={t("Cancel")}
        prominence="secondary"
        disabled={busy}
        onPress={() => {
          oauth.cancel();
          onCancel();
        }}
      />
    </View>
  );
}
