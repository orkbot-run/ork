// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { WELCOME_AVATAR_COLOR, WELCOME_AVATAR_IDENTITY } from "@orkbot/core";
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AccountServer } from "../lib/account-servers";
import { accountServers, addAccountServer } from "../lib/account-servers";
import {
  accountsIdentity,
  accountsVersion,
  continueWithAccounts,
  signOutAccounts,
  subscribeAccounts,
} from "../lib/accounts";
import { FORM_COLUMN_WIDTH } from "../lib/adaptive-layout";
import { clearProductAccountSession, loadApiBase, probeApiBase, saveApiBase } from "../lib/api";
import { loadAppearancePreference } from "../lib/appearance";
import { displayApiHost, requireAccountsSignIn } from "../lib/endpoint";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { serverHeaders } from "../lib/server-headers";
import { errorText } from "../lib/user-error";
import { LogoAvatar } from "./logo-avatar";
import { NativeActionButton } from "./native-action-button";

const ACCOUNT_KEY = "orkbot.accounts.product-owner";
const SERVER_KEY = "orkbot.accounts.selected-server";
let ownershipChanges = Promise.resolve();

function serializeOwnership<T>(operation: () => Promise<T>): Promise<T> {
  const result = ownershipChanges.then(operation);
  ownershipChanges = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function adoptAccount(account: string | null, current: () => boolean): Promise<boolean> {
  return serializeOwnership(async () => {
    if (!current()) return false;
    const previous = await SecureStore.getItemAsync(ACCOUNT_KEY);
    if (!current()) return false;
    if (account === null || previous !== account) {
      await clearProductAccountSession();
      if (!current()) return false;
      await SecureStore.deleteItemAsync(SERVER_KEY);
      if (!current()) return false;
      if (account === null) await SecureStore.deleteItemAsync(ACCOUNT_KEY);
      else await SecureStore.setItemAsync(ACCOUNT_KEY, account);
    }
    return current();
  });
}

async function selectServer(
  entry: AccountServer,
  account: string,
  current: () => boolean,
): Promise<boolean> {
  return serializeOwnership(async () => {
    if (!current()) return false;
    const savedOwner = await SecureStore.getItemAsync(ACCOUNT_KEY);
    if (!current() || savedOwner !== account) return false;
    await requireAccountsSignIn(entry.url, serverHeaders(entry.url));
    if (!current()) return false;
    await loadApiBase();
    if (!current()) return false;
    const saved = await saveApiBase(entry.url, serverHeaders(entry.url));
    if (!saved.ok) throw new Error(saved.error);
    if (!current()) return false;
    await SecureStore.setItemAsync(SERVER_KEY, `${account}:${entry.id}`);
    return current();
  });
}

/** Accounts must be ready before product screens or their background requests can mount. */
export function AccountsGate({
  children,
  onSelected,
}: {
  children?: ReactNode;
  onSelected?: () => void;
}) {
  const { t } = useI18n();
  const productGate = Boolean(children);
  const tokens = useMobileTokens();
  const version = useSyncExternalStore(subscribeAccounts, accountsVersion, accountsVersion);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "servers" | "recovery" | "ready">(
    "loading",
  );
  const [servers, setServers] = useState<AccountServer[]>([]);
  const [started, setStarted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readyAt, setReadyAt] = useState({ version: -1, attempt: -1 });
  const owner = useRef("");
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setPhase("loading");
    setError(null);
    setPending(false);
    let verified = false;
    let directoryReady = false;
    void (async () => {
      await Promise.all([bootstrapI18n(), loadAppearancePreference()]);
      const identity = await accountsIdentity();
      if (generation.current !== current) return;
      if (!identity) {
        if (!(await adoptAccount(null, () => generation.current === current))) return;
        owner.current = "";
        setServers([]);
        setDraft("");
        setReadyAt({ version, attempt });
        setPhase("signed-out");
        return;
      }
      const account = JSON.stringify([identity.issuer, identity.subject]);
      if (!(await adoptAccount(account, () => generation.current === current))) return;
      owner.current = account;
      verified = true;
      const entries = await accountServers(account);
      if (generation.current !== current) return;
      setServers(entries);
      directoryReady = true;
      setAdding(entries.length === 0);
      if (productGate) {
        const selected = await SecureStore.getItemAsync(SERVER_KEY);
        if (generation.current !== current) return;
        const previous = entries.find((entry) => `${account}:${entry.id}` === selected);
        if (previous) {
          if (await selectServer(previous, account, () => generation.current === current)) {
            setReadyAt({ version, attempt });
            setPhase("ready");
          }
          return;
        }
      }
      setReadyAt({ version, attempt });
      setPhase("servers");
    })()
      .catch((failure) => {
        if (generation.current !== current) return;
        setError(errorText(failure));
        setReadyAt({ version, attempt });
        setPhase(verified ? (directoryReady ? "servers" : "recovery") : "signed-out");
      })
      .finally(() => {
        if (generation.current === current) void SplashScreen.hideAsync().catch(() => undefined);
      });
    return () => {
      generation.current += 1;
    };
  }, [version, attempt, productGate]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setAttempt((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  async function action(operation: () => Promise<unknown>) {
    if (pending) return;
    const current = generation.current;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (generation.current === current) setError(errorText(failure));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }

  async function select(entry: AccountServer) {
    const current = generation.current;
    const account = owner.current;
    const identity = await accountsIdentity();
    if (
      generation.current !== current ||
      !identity ||
      JSON.stringify([identity.issuer, identity.subject]) !== account
    ) {
      setAttempt((value) => value + 1);
      return;
    }
    const probe = await probeApiBase(entry.url);
    if (!probe.ok) throw new Error(probe.error);
    if (generation.current !== current) return;
    if (!(await selectServer(entry, account, () => generation.current === current))) return;
    if (onSelected) onSelected();
    else {
      setReadyAt({ version, attempt });
      setPhase("ready");
    }
  }

  if (phase === "ready" && readyAt.version === version && readyAt.attempt === attempt && children)
    return <>{children}</>;
  const visiblePhase =
    readyAt.version === version && readyAt.attempt === attempt ? phase : "loading";
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 28,
          gap: 20,
          width: "100%",
          maxWidth: FORM_COLUMN_WIDTH,
          alignSelf: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center" }}>
          <LogoAvatar
            identity={WELCOME_AVATAR_IDENTITY}
            color={WELCOME_AVATAR_COLOR}
            size={visiblePhase === "servers" || visiblePhase === "recovery" ? 112 : 220}
            activity="idle"
            motion="live"
          />
        </View>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 30, fontWeight: "600", color: tokens.foreground, textAlign: "center" }}
        >
          {visiblePhase === "servers" || visiblePhase === "recovery"
            ? t("Server")
            : t("Welcome to Ork")}
        </Text>
        {visiblePhase === "loading" ? (
          <ActivityIndicator accessibilityLabel={t("Loading…")} color={tokens.mutedForeground} />
        ) : visiblePhase === "signed-out" ? (
          <>
            <NativeActionButton
              label={started ? t("Continue with {name}", { name: "Accounts" }) : t("Get started")}
              busy={pending}
              onPress={() => (started ? void action(continueWithAccounts) : setStarted(true))}
            />
            {error ? (
              <NativeActionButton
                label={t("Retry")}
                prominence="plain"
                onPress={() => setAttempt((value) => value + 1)}
              />
            ) : null}
          </>
        ) : (
          <>
            {visiblePhase === "servers" ? (
              <>
                {servers.map((entry) => (
                  <NativeActionButton
                    key={entry.id}
                    label={displayApiHost(entry.url)}
                    busy={pending}
                    onPress={() => void action(() => select(entry))}
                  />
                ))}
                {adding ? (
                  <>
                    <TextInput
                      accessibilityLabel={t("Server")}
                      placeholder="https://orkbot.example.com"
                      placeholderTextColor={tokens.mutedForeground}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      value={draft}
                      onChangeText={setDraft}
                      editable={!pending}
                      style={{
                        color: tokens.foreground,
                        backgroundColor: tokens.muted,
                        padding: 16,
                        borderRadius: 12,
                      }}
                    />
                    <NativeActionButton
                      label={t("Add")}
                      busy={pending}
                      disabled={!draft.trim()}
                      onPress={() =>
                        void action(async () => {
                          const current = generation.current;
                          const account = owner.current;
                          const entry = await addAccountServer(draft, account);
                          if (generation.current !== current) return;
                          setServers((previous) => [
                            ...previous.filter((item) => item.id !== entry.id),
                            entry,
                          ]);
                          setDraft("");
                          await select(entry);
                        })
                      }
                    />
                  </>
                ) : (
                  <NativeActionButton
                    label={t("Add")}
                    prominence="secondary"
                    onPress={() => setAdding(true)}
                  />
                )}
              </>
            ) : null}
            {error ? (
              <NativeActionButton
                label={t("Retry")}
                onPress={() => setAttempt((value) => value + 1)}
              />
            ) : null}
            <NativeActionButton
              label={t("Sign out")}
              prominence="plain"
              onPress={() => void action(signOutAccounts)}
            />
          </>
        )}
        {error && visiblePhase !== "loading" ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
