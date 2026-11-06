// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isPersonalOrkId, seededLogoAvatarColor } from "@orkbot/core";
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
  welcomeAccountsOrk,
} from "../lib/accounts";
import { FORM_COLUMN_WIDTH } from "../lib/adaptive-layout";
import {
  clearProductAccountSession,
  currentApiBase,
  loadApiBase,
  probeApiBase,
  rpc,
  saveApiBase,
} from "../lib/api";
import { loadAppearancePreference } from "../lib/appearance";
import { displayApiHost, normalizeApiBase, requireAccountsSignIn } from "../lib/endpoint";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import {
  clearServerConnect,
  pendingServerConnect,
  subscribeServerConnect,
} from "../lib/server-connect";
import { serverHeaders } from "../lib/server-headers";
import { currentSessionGeneration } from "../lib/session";
import { continueWithSso } from "../lib/sso";
import { errorText } from "../lib/user-error";
import { LogoAvatar } from "./logo-avatar";
import { NativeActionButton } from "./native-action-button";

const ACCOUNT_KEY = "orkbot.accounts.product-owner";
const SERVER_KEY = "orkbot.accounts.selected-server";
let ownershipChanges = Promise.resolve();
const welcomeOrk = welcomeAccountsOrk();

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
  const linkedServer = useSyncExternalStore(
    subscribeServerConnect,
    pendingServerConnect,
    pendingServerConnect,
  );
  const operationPending = useRef(false);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "servers" | "recovery" | "ready">(
    "loading",
  );
  const [orkAvatar, setOrkAvatar] = useState(welcomeOrk);
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
        setOrkAvatar(welcomeOrk);
        setServers([]);
        setDraft("");
        setReadyAt({ version, attempt });
        setPhase("signed-out");
        return;
      }
      setOrkAvatar(isPersonalOrkId(identity.orkAvatar) ? identity.orkAvatar : welcomeOrk);
      const account = JSON.stringify([identity.issuer, identity.subject]);
      if (!(await adoptAccount(account, () => generation.current === current))) return;
      owner.current = account;
      verified = true;
      const entries = await accountServers(account);
      if (generation.current !== current) return;
      setServers(entries);
      directoryReady = true;
      setAdding(Boolean(linkedServer) || entries.length === 0);
      if (linkedServer) setDraft(linkedServer);
      if (productGate && !linkedServer) {
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
  }, [version, attempt, productGate, linkedServer]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !operationPending.current) setAttempt((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  async function action(operation: () => Promise<unknown>) {
    if (operationPending.current) return;
    operationPending.current = true;
    const current = generation.current;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (generation.current === current) setError(errorText(failure));
    } finally {
      operationPending.current = false;
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
    if (linkedServer) clearServerConnect(linkedServer);
  }

  if (
    phase === "ready" &&
    readyAt.version === version &&
    readyAt.attempt === attempt &&
    !linkedServer &&
    children
  )
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
            identity={orkAvatar}
            color={seededLogoAvatarColor(orkAvatar)}
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
              onPress={() =>
                started ? void action(() => continueWithAccounts(welcomeOrk)) : setStarted(true)
              }
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
                          const parsed = normalizeApiBase(draft);
                          if (!parsed.ok) throw new Error(parsed.error);
                          const target = parsed.url;
                          const currentOperation = () =>
                            generation.current === current && owner.current === account;
                          const probe = await probeApiBase(target);
                          if (!probe.ok) throw new Error(probe.error);
                          await requireAccountsSignIn(target, serverHeaders(target));
                          if (!currentOperation()) return;
                          await loadApiBase();
                          if (!currentOperation()) return;
                          const saved = await saveApiBase(target, serverHeaders(target));
                          if (!saved.ok) throw new Error(saved.error);
                          if (!currentOperation()) return;
                          if (!(await continueWithSso())) return;
                          if (!currentOperation() || currentApiBase() !== target) return;
                          const sessionGeneration = currentSessionGeneration();
                          const me = await rpc("me");
                          if (
                            !me.userId ||
                            !currentOperation() ||
                            currentApiBase() !== target ||
                            currentSessionGeneration() !== sessionGeneration
                          )
                            return;
                          const entry = await addAccountServer(target, account);
                          if (
                            !currentOperation() ||
                            currentApiBase() !== target ||
                            currentSessionGeneration() !== sessionGeneration
                          )
                            return;
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
