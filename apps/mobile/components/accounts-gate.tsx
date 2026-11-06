// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isPersonalOrkId, seededLogoAvatarColor } from "@orkbot/core";
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
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
import { continueWithAccountsServer } from "../lib/accounts-login";
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
  confirmServerInitialization,
  hasPendingServerInitialization,
  pendingServerConnect,
  subscribeServerConnect,
} from "../lib/server-connect";
import { serverHeaders } from "../lib/server-headers";
import type { MobileServerPairing } from "../lib/server-pairing";
import { beginServerPairing } from "../lib/server-pairing";
import { currentSessionGeneration } from "../lib/session";
import { continueWithSso } from "../lib/sso";
import { errorText } from "../lib/user-error";
import { LogoAvatar } from "./logo-avatar";
import { NativeActionButton } from "./native-action-button";

const ACCOUNT_KEY = "orkbot.accounts.product-owner";
const SERVER_KEY = "orkbot.accounts.selected-server";
let ownershipChanges = Promise.resolve();
const welcomeOrk = welcomeAccountsOrk();

type PairingWait = {
  session: MobileServerPairing;
  account: string;
  generation: number;
  server: string;
  sessionGeneration: number;
};

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
  const operationVersion = useRef(0);
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
  const pairingRef = useRef<PairingWait | null>(null);
  const creatingPairing = useRef<AbortController | null>(null);
  const [pairing, setPairing] = useState<PairingWait | null>(null);
  const [pairingForeground, setPairingForeground] = useState(true);

  function discardPairing(update = true) {
    const creating = creatingPairing.current;
    creatingPairing.current = null;
    creating?.abort();
    if (creating) {
      operationVersion.current += 1;
      operationPending.current = false;
      if (update) setPending(false);
    }
    const previous = pairingRef.current;
    pairingRef.current = null;
    if (previous) void previous.session.cancel().catch(() => undefined);
    if (update) setPairing(null);
  }

  useEffect(() => {
    const current = ++generation.current;
    discardPairing();
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
      discardPairing(false);
    };
  }, [version, attempt, productGate, linkedServer]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setPairingForeground(state === "active");
      if (state === "active" && !operationPending.current && !pairingRef.current)
        setAttempt((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  async function action(operation: () => Promise<unknown>) {
    if (operationPending.current) return;
    const operationId = ++operationVersion.current;
    operationPending.current = true;
    const current = generation.current;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      if (generation.current === current) setError(errorText(failure));
    } finally {
      if (operationVersion.current === operationId) {
        operationPending.current = false;
        if (generation.current === current) setPending(false);
      }
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
    confirmServerInitialization(entry.url, account!);
    if (onSelected) onSelected();
    else {
      setReadyAt({ version, attempt });
      setPhase("ready");
    }
    if (linkedServer) clearServerConnect(linkedServer);
  }

  async function connectPairedServer(wait: PairingWait) {
    const current = () => generation.current === wait.generation && owner.current === wait.account;
    const untouched = () =>
      current() &&
      currentApiBase() === wait.server &&
      currentSessionGeneration() === wait.sessionGeneration;
    const entries = await accountServers(wait.account);
    if (!untouched()) return;
    const entry = entries.find((value) => value.url === wait.session.ticket.origin);
    if (!entry) throw new Error(t("Could not pair this server. Try again."));
    const target = entry.url;
    const probe = await probeApiBase(target);
    if (!probe.ok) throw new Error(probe.error);
    const capabilities = await requireAccountsSignIn(target, serverHeaders(target));
    if (!capabilities.accountsLogin)
      throw new Error(t("This server does not support pairing codes. Update it and try again."));
    if (!untouched()) return;
    await loadApiBase();
    if (!untouched()) return;
    const saved = await saveApiBase(target, serverHeaders(target));
    if (!saved.ok) throw new Error(saved.error);
    if (!current() || !(await continueWithAccountsServer())) return;
    if (!current() || currentApiBase() !== target) return;
    const sessionGeneration = currentSessionGeneration();
    const me = await rpc("me");
    if (
      !me.userId ||
      !current() ||
      currentApiBase() !== target ||
      currentSessionGeneration() !== sessionGeneration
    )
      return;
    setServers(entries);
    setDraft("");
    await select(entry);
  }

  useEffect(() => {
    if (!pairing || !pairingForeground) return;
    const wait = pairing;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      !controller.signal.aborted &&
      pairingRef.current === wait &&
      generation.current === wait.generation &&
      owner.current === wait.account &&
      currentApiBase() === wait.server &&
      currentSessionGeneration() === wait.sessionGeneration;
    const stale = () => {
      if (current()) return false;
      if (!controller.signal.aborted && pairingRef.current === wait) discardPairing();
      return true;
    };
    async function poll() {
      try {
        if (stale()) return;
        const result = await wait.session.state(controller.signal);
        if (stale()) return;
        if (result.status === "ready") {
          pairingRef.current = null;
          setPairing(null);
          void action(() => connectPairedServer(wait));
        } else if (result.status === "pending") {
          timer = setTimeout(() => void poll(), 2_000);
        } else {
          discardPairing();
          setError(
            t(
              result.status === "expired"
                ? "Pairing code expired. Generate a new code."
                : "Could not pair this server. Try again.",
            ),
          );
        }
      } catch (failure) {
        if (stale()) return;
        discardPairing();
        setError(errorText(failure));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pairing, pairingForeground]);

  async function createPairing() {
    const controller = new AbortController();
    creatingPairing.current = controller;
    const current = generation.current;
    const account = owner.current;
    const server = currentApiBase();
    const sessionGeneration = currentSessionGeneration();
    try {
      const session = await beginServerPairing(draft, account, controller.signal);
      if (
        controller.signal.aborted ||
        generation.current !== current ||
        owner.current !== account ||
        currentApiBase() !== server ||
        currentSessionGeneration() !== sessionGeneration
      ) {
        void session.cancel().catch(() => undefined);
        return;
      }
      const wait: PairingWait = {
        session,
        account,
        generation: current,
        server,
        sessionGeneration,
      };
      pairingRef.current = wait;
      setPairing(wait);
    } finally {
      if (creatingPairing.current === controller) creatingPairing.current = null;
    }
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
                    disabled={Boolean(pairing)}
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
                      editable={!pending && !pairing}
                      style={{
                        color: tokens.foreground,
                        backgroundColor: tokens.muted,
                        padding: 16,
                        borderRadius: 12,
                      }}
                    />
                    {pairing ? (
                      <>
                        <Text
                          selectable
                          accessibilityLabel={t("Pairing code")}
                          style={{
                            color: tokens.foreground,
                            fontSize: 36,
                            fontWeight: "600",
                            letterSpacing: 4,
                            textAlign: "center",
                          }}
                        >
                          {pairing.session.ticket.code.slice(0, 3)}{" "}
                          {pairing.session.ticket.code.slice(3)}
                        </Text>
                        <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                          {t("Enter this code on your server's initialization page.")}
                        </Text>
                        <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                          {t("Expires {date}", {
                            date: new Date(
                              pairing.session.ticket.expiresAt * 1000,
                            ).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
                          })}
                        </Text>
                        <NativeActionButton
                          label={t("Copy code")}
                          prominence="secondary"
                          onPress={() =>
                            void import("expo-clipboard")
                              .then(({ setStringAsync }) =>
                                setStringAsync(pairing.session.ticket.code),
                              )
                              .catch(() => setError(t("Could not copy the code.")))
                          }
                        />
                        <NativeActionButton
                          label={t("Open server")}
                          prominence="secondary"
                          onPress={() =>
                            void Linking.openURL(pairing.session.ticket.origin).catch(() =>
                              setError(t("Could not open the server.")),
                            )
                          }
                        />
                        <NativeActionButton
                          label={t("Cancel")}
                          prominence="plain"
                          onPress={() => discardPairing()}
                        />
                      </>
                    ) : (
                      <NativeActionButton
                        label={hasPendingServerInitialization(draft) ? t("Add") : t("Pairing code")}
                        busy={pending}
                        disabled={!draft.trim()}
                        onPress={() =>
                          void action(
                            hasPendingServerInitialization(draft)
                              ? async () => {
                                  const current = generation.current;
                                  const account = owner.current;
                                  const parsed = normalizeApiBase(draft);
                                  if (!parsed.ok) throw new Error(parsed.error);
                                  const target = parsed.url;
                                  const currentOperation = () =>
                                    generation.current === current && owner.current === account;
                                  const probe = await probeApiBase(target);
                                  if (!probe.ok) throw new Error(probe.error);
                                  const capabilities = await requireAccountsSignIn(
                                    target,
                                    serverHeaders(target),
                                  );
                                  if (!currentOperation()) return;
                                  await loadApiBase();
                                  if (!currentOperation()) return;
                                  const saved = await saveApiBase(target, serverHeaders(target));
                                  if (!saved.ok) throw new Error(saved.error);
                                  if (!currentOperation()) return;
                                  if (account) confirmServerInitialization(target, account);
                                  if (
                                    !(await (capabilities.accountsLogin
                                      ? continueWithAccountsServer()
                                      : continueWithSso()))
                                  )
                                    return;
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
                                }
                              : createPairing,
                          )
                        }
                      />
                    )}
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
              onPress={() => {
                discardPairing();
                void action(signOutAccounts);
              }}
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
