// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IdentityCatalog } from "@orkbot/contracts";
import {
  initialCatalogOrganization,
  initialCatalogWorkspace,
  SERVER_INSTALL_COMMAND,
  SERVER_UPDATE_RECOVERY_PROTOCOL,
} from "@orkbot/contracts";
import { isPersonalOrkId, seededLogoAvatarColor } from "@orkbot/core";
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Updates from "../app/(settings)/updates";
import type { AccountServer } from "../lib/account-servers";
import {
  accountDirectory,
  accountServers,
  addAccountServer,
  setDefaultAccountOrganization,
} from "../lib/account-servers";
import {
  accountsIdentity,
  accountsVersion,
  continueWithAccounts,
  signOutAccounts,
  subscribeAccounts,
  welcomeAccountsOrk,
} from "../lib/accounts";
import { continueWithAccountsServer } from "../lib/accounts-login";
import { AccountsUnavailable } from "../lib/accounts-network";
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
import {
  normalizeApiBase,
  requireAccountsSignIn,
  serverInitializationRequired,
} from "../lib/endpoint";
import { bootstrapI18n, useI18n } from "../lib/i18n";
import { selectInstallationTransport } from "../lib/installation-transport";
import { useMobileTokens } from "../lib/native";
import { continueWithPersonalServer, personalLoginSelection } from "../lib/personal-login";
import {
  lastOrganizationWorkspace,
  saveSelectedWorkspace,
  selectedWorkspace,
} from "../lib/selected-workspace";
import {
  clearServerConnect,
  clearWorkspaceConnect,
  confirmServerInitialization,
  hasPendingServerInitialization,
  pendingServerConnect,
  pendingWorkspaceConnect,
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
import { WorkspaceDirectory, workspaceEntries } from "./workspace-directory";

const ACCOUNT_KEY = "orkbot.accounts.product-owner";
const SERVER_KEY = "orkbot.accounts.selected-server";
const DIRECTORY_REFRESH_MS = 15_000;
// Personal server pairing is temporarily disabled; workspace membership grants access.
const PERSONAL_SERVER_CONNECTION_ENABLED = false;
let ownershipChanges = Promise.resolve();
const welcomeOrk = welcomeAccountsOrk();

function probeCompatibleServer(url: string, older?: boolean) {
  return older
    ? probeApiBase(url, undefined, {}, SERVER_UPDATE_RECOVERY_PROTOCOL)
    : probeApiBase(url);
}

type PairingWait = {
  session: MobileServerPairing;
  origin: string | null;
  approvedOrigin: string | null;
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
  expectedSession?: number,
  expectedServer?: string,
): Promise<"compatible" | "older" | null> {
  return serializeOwnership(async () => {
    const beforeSave = () =>
      current() &&
      (expectedSession === undefined || currentSessionGeneration() === expectedSession) &&
      (expectedServer === undefined || currentApiBase() === expectedServer);
    if (!beforeSave()) return null;
    const savedOwner = await SecureStore.getItemAsync(ACCOUNT_KEY);
    if (!beforeSave() || savedOwner !== account) return null;
    if (entry.relay) {
      await selectInstallationTransport(account, entry.url, entry.workspace, entry.relay);
      if (!beforeSave()) return null;
    }
    const capabilities = await requireAccountsSignIn(entry.url, serverHeaders(entry.url));
    if (!beforeSave()) return null;
    await loadApiBase();
    if (!beforeSave()) return null;
    // Changing the endpoint may itself clear and replace the product session.
    const saved = await saveApiBase(entry.url, serverHeaders(entry.url));
    if (!saved.ok) throw new Error(saved.error);
    if (!current()) return null;
    const previousWorkspace = await selectedWorkspace(account, entry.url);
    if (!current()) return null;
    if (JSON.stringify(previousWorkspace) !== JSON.stringify(entry.workspace ?? null)) {
      await clearProductAccountSession();
      if (!current()) return null;
    }
    await saveSelectedWorkspace(account, entry.url, entry.workspace, entry.relay);
    if (!current()) return null;
    await selectInstallationTransport(account, entry.url, entry.workspace, entry.relay);
    if (!current()) return null;
    await SecureStore.setItemAsync(SERVER_KEY, `${account}:${entry.id}`);
    return current() ? (capabilities.needsServerUpdate ? "older" : "compatible") : null;
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
  const linkGeneration = useRef(0);
  const subscribeLinks = useCallback(
    (listener: () => void) =>
      subscribeServerConnect(() => {
        linkGeneration.current += 1;
        listener();
      }),
    [],
  );
  const linkSnapshot = useSyncExternalStore(
    subscribeLinks,
    () => `${linkGeneration.current}:${pendingServerConnect() ?? ""}`,
    () => `${linkGeneration.current}:${pendingServerConnect() ?? ""}`,
  );
  const linkedServer = pendingServerConnect();
  const linkedWorkspace = pendingWorkspaceConnect();
  const operationPending = useRef(false);
  const operationVersion = useRef(0);
  const [phase, setPhase] = useState<"loading" | "signed-out" | "servers" | "recovery" | "ready">(
    "loading",
  );
  const [orkAvatar, setOrkAvatar] = useState(welcomeOrk);
  const [servers, setServers] = useState<AccountServer[]>([]);
  const [directory, setDirectory] = useState<IdentityCatalog | null>(null);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const chosenOrganization = useRef<{ account: string; id: string | null }>({
    account: "",
    id: null,
  });
  const [started, setStarted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [linkNeedsPairing, setLinkNeedsPairing] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverRescue, setServerRescue] = useState(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readyAt, setReadyAt] = useState({ version: -1, attempt: -1 });
  const owner = useRef("");
  const directoryOwner = useRef("");
  const knownServers = useRef(new Set<string>());
  const discoveryAlert = useRef(false);
  const translate = useRef(t);
  translate.current = t;
  const generation = useRef(0);
  const pairingRef = useRef<PairingWait | null>(null);
  const pairingRequest = useRef<AbortController | null>(null);
  const [pairing, setPairing] = useState<PairingWait | null>(null);
  const [pairingForeground, setPairingForeground] = useState(
    AppState.currentState == null || AppState.currentState === "active",
  );

  function discardPairing(update = true) {
    const creating = pairingRequest.current;
    pairingRequest.current = null;
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
    const receivedLink = linkGeneration.current;
    const initializationRequest = new AbortController();
    setLinkNeedsPairing(null);
    discardPairing();
    setPhase("loading");
    setError(null);
    setPending(false);
    let verified = false;
    let directoryReady = false;
    let personalAttempted = false;
    const restorePersonal = async () => {
      if (!productGate || linkedServer || linkedWorkspace || personalAttempted) return false;
      personalAttempted = true;
      const active = () =>
        generation.current === current &&
        accountsVersion() === version &&
        linkGeneration.current === receivedLink;
      const credential = await personalLoginSelection(verified ? owner.current : undefined);
      if (!credential || !active()) return false;
      await loadApiBase();
      if (
        !active() ||
        currentApiBase() !== credential.origin ||
        !(await adoptAccount(credential.account, active))
      )
        return false;
      if (!(await continueWithPersonalServer(credential, active)) || !active()) return false;
      owner.current = credential.account;
      setServerRescue(false);
      setReadyAt({ version, attempt });
      setPhase("ready");
      return true;
    };
    void (async () => {
      await Promise.all([bootstrapI18n(), loadAppearancePreference()]);
      const identity = await accountsIdentity();
      if (generation.current !== current) return;
      if (!identity) {
        if (await restorePersonal()) return;
        if (!(await adoptAccount(null, () => generation.current === current))) return;
        owner.current = "";
        directoryOwner.current = "";
        knownServers.current.clear();
        setOrkAvatar(welcomeOrk);
        setServers([]);
        setDirectory(null);
        setOrganizationId(null);
        chosenOrganization.current = { account: "", id: null };
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
      const directorySession = currentSessionGeneration();
      const directoryServer = currentApiBase();
      const loaded = await accountDirectory(account);
      const { entries, catalog } = loaded;
      if (generation.current !== current) return;
      const organization =
        chosenOrganization.current.account === account && chosenOrganization.current.id !== null
          ? catalog.organizations.find((row) => row.id === chosenOrganization.current.id)
          : initialCatalogOrganization(catalog);
      chosenOrganization.current = { account, id: organization?.id ?? null };
      setOrganizationId(organization?.id ?? null);
      setDirectory(catalog);
      if (directoryOwner.current !== account) {
        directoryOwner.current = account;
        knownServers.current = new Set(entries.map((entry) => entry.id));
      }
      setServers(entries);
      directoryReady = true;
      setAdding(Boolean(linkedServer) || entries.length === 0);
      if (linkedServer) setDraft(linkedServer);
      if (linkedWorkspace) {
        const requestedOrganization = catalog.organizations.find(
          (row) => row.id === linkedWorkspace.organizationId,
        );
        chosenOrganization.current = { account, id: requestedOrganization?.id ?? null };
        setOrganizationId(requestedOrganization?.id ?? null);
        const requested = entries.find(
          (row) =>
            row.workspace?.organizationId === linkedWorkspace.organizationId &&
            row.workspace.serverId === linkedWorkspace.serverId &&
            row.workspace.workspaceId === linkedWorkspace.workspaceId,
        );
        if (!requested) throw new Error(t("Workspace unavailable"));
        await select(requested, {
          current: () =>
            generation.current === current && pendingWorkspaceConnect() === linkedWorkspace,
          sessionGeneration: directorySession,
          server: directoryServer,
        });
        return;
      }

      if (
        PERSONAL_SERVER_CONNECTION_ENABLED &&
        linkedServer &&
        !hasPendingServerInitialization(linkedServer)
      ) {
        const currentLink = () =>
          generation.current === current &&
          accountsVersion() === version &&
          linkGeneration.current === receivedLink &&
          owner.current === account &&
          pendingServerConnect() === linkedServer &&
          !hasPendingServerInitialization(linkedServer);
        const handoff = {
          current: currentLink,
          sessionGeneration: directorySession,
          server: directoryServer,
        };
        const linked = entries.find((entry) => entry.url === linkedServer);
        if (linked) {
          if (await select(linked, handoff)) return;
        } else if (currentLink() && currentSessionGeneration() === directorySession) {
          const required = await serverInitializationRequired(
            linkedServer,
            undefined,
            initializationRequest.signal,
          );
          if (!currentLink()) return;
          if (
            currentSessionGeneration() !== directorySession ||
            currentApiBase() !== handoff.server
          )
            throw new Error(t("Could not pair this server. Try again."));
          setLinkNeedsPairing(required);
          if (!required) {
            let connected = false;
            await action(async () => {
              connected = await connectServer(linkedServer, handoff);
            });
            if (connected) return;
          }
        }
        if (generation.current !== current) return;
      }
      if (productGate && !linkedServer && organization) {
        const remembered = await lastOrganizationWorkspace(account, organization.id);
        const selected = await SecureStore.getItemAsync(SERVER_KEY);
        if (generation.current !== current) return;
        const available = workspaceEntries(organization, entries);
        const legacy = available.find((entry) => `${account}:${entry.id}` === selected);
        const legacyServer = organization.servers.find((server) =>
          server.workspaces.some((workspace) => workspace.id === legacy?.id),
        );
        const target = initialCatalogWorkspace(
          catalog,
          organization.id,
          remembered ??
            (legacy && legacyServer ? { workspaceId: legacy.id, serverId: legacyServer.id } : null),
        );
        const previous =
          target &&
          available.find(
            (entry) =>
              entry.id === target.workspaceId &&
              (!entry.workspace || entry.workspace.serverId === target.serverId),
          );
        if (previous) {
          const selected = await selectServer(
            previous,
            account,
            () => generation.current === current,
          );
          if (selected) {
            setServerRescue(selected === "older");
            setReadyAt({ version, attempt });
            setPhase("ready");
          }
          return;
        }
      }
      setReadyAt({ version, attempt });
      setPhase("servers");
    })()
      .catch(async (failure) => {
        if (failure instanceof AccountsUnavailable) {
          try {
            if (await restorePersonal()) return;
          } catch (personalFailure) {
            failure = personalFailure;
          }
        }
        if (generation.current !== current) return;
        setError(errorText(failure));
        setReadyAt({ version, attempt });
        setPhase(verified ? (directoryReady ? "servers" : "recovery") : "signed-out");
      })
      .finally(() => {
        if (generation.current === current) void SplashScreen.hideAsync().catch(() => undefined);
      });
    return () => {
      initializationRequest.abort();
      generation.current += 1;
      discardPairing(false);
    };
  }, [version, attempt, productGate, linkedServer, linkSnapshot]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setPairingForeground(state === "active");
      if (state === "active" && !operationPending.current && !pairingRef.current)
        setAttempt((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (
      (phase !== "servers" && !(productGate && phase === "ready")) ||
      readyAt.version !== version ||
      readyAt.attempt !== attempt ||
      !pairingForeground ||
      linkedServer ||
      !owner.current
    )
      return;
    const account = owner.current;
    const currentGeneration = generation.current;
    const sessionGeneration = currentSessionGeneration();
    const activeServer = currentApiBase();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sameSession = () =>
      generation.current === currentGeneration &&
      owner.current === account &&
      accountsVersion() === version &&
      currentSessionGeneration() === sessionGeneration &&
      currentApiBase() === activeServer;
    const current = () => !cancelled && sameSession();
    async function poll() {
      if (!current()) return;
      if (!operationPending.current && !pairingRef.current) {
        try {
          const { entries, catalog } = await accountDirectory(account);
          if (!current()) return;
          setDirectory(catalog);
          const added = entries.some(
            (entry) => !knownServers.current.has(entry.id) && entry.url !== activeServer,
          );
          knownServers.current = new Set(entries.map((entry) => entry.id));
          setServers(entries);
          if (added && phase === "ready") {
            if (!discoveryAlert.current) {
              discoveryAlert.current = true;
              Alert.alert(
                translate.current("New server available"),
                undefined,
                [
                  {
                    text: translate.current("Later"),
                    style: "cancel",
                    onPress: () => {
                      discoveryAlert.current = false;
                    },
                  },
                  {
                    text: translate.current("Open servers"),
                    onPress: () => {
                      discoveryAlert.current = false;
                      if (!current()) return;
                      setAdding(false);
                      setPhase("servers");
                    },
                  },
                ],
                {
                  cancelable: true,
                  onDismiss: () => {
                    discoveryAlert.current = false;
                  },
                },
              );
            }
          }
        } catch {
          // Directory outages must not interrupt the active server.
        }
      }
      if (current()) timer = setTimeout(() => void poll(), DIRECTORY_REFRESH_MS);
    }
    timer = setTimeout(() => void poll(), DIRECTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [attempt, linkedServer, pairingForeground, phase, productGate, readyAt, version]);

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
      if (generation.current === current && operationVersion.current === operationId)
        setError(errorText(failure));
    } finally {
      if (operationVersion.current === operationId) {
        operationPending.current = false;
        if (generation.current === current) setPending(false);
      }
    }
  }

  async function select(
    entry: AccountServer,
    handoff?: { current: () => boolean; sessionGeneration: number; server?: string },
  ): Promise<boolean> {
    const current = generation.current;
    const account = owner.current;
    const accountVersion = accountsVersion();
    const active = () =>
      generation.current === current &&
      accountsVersion() === accountVersion &&
      (handoff?.current() ?? true);
    const sessionCurrent = () =>
      handoff === undefined ||
      (currentSessionGeneration() === handoff.sessionGeneration &&
        (handoff.server === undefined || currentApiBase() === handoff.server));
    if (!active() || !sessionCurrent()) return false;
    const identity = await accountsIdentity();
    if (!active() || !sessionCurrent()) return false;
    if (!identity || JSON.stringify([identity.issuer, identity.subject]) !== account) {
      setAttempt((value) => value + 1);
      return false;
    }
    if (entry.relay) {
      await selectInstallationTransport(account, entry.url, entry.workspace, entry.relay);
      if (!active() || !sessionCurrent()) return false;
    }
    const capabilities = await requireAccountsSignIn(entry.url, serverHeaders(entry.url));
    const probe = await probeCompatibleServer(entry.url, capabilities.needsServerUpdate);
    if (!active() || !sessionCurrent()) return false;
    if (!probe.ok) throw new Error(probe.error);
    const selected = await selectServer(
      entry,
      account,
      active,
      handoff?.sessionGeneration,
      handoff?.server,
    );
    if (!selected) return false;
    setServerRescue(selected === "older");
    knownServers.current.add(entry.id);
    confirmServerInitialization(entry.url, account!);
    if (onSelected) onSelected();
    else {
      setReadyAt({ version, attempt });
      setPhase("ready");
    }
    if (linkedServer) clearServerConnect(linkedServer);
    if (linkedWorkspace) clearWorkspaceConnect(linkedWorkspace);
    return true;
  }

  async function connectServer(
    input: string,
    handoff?: { current: () => boolean; sessionGeneration: number; server: string },
  ): Promise<boolean> {
    const current = generation.current;
    const account = owner.current;
    const accountVersion = accountsVersion();
    const receivedLink = linkGeneration.current;
    const link = pendingServerConnect();
    const server = handoff?.server ?? currentApiBase();
    const session = handoff?.sessionGeneration ?? currentSessionGeneration();
    const currentOperation = () =>
      generation.current === current &&
      owner.current === account &&
      accountsVersion() === accountVersion &&
      linkGeneration.current === receivedLink &&
      pendingServerConnect() === link &&
      (handoff?.current() ?? true);
    const untouched = () =>
      currentOperation() && currentApiBase() === server && currentSessionGeneration() === session;
    if (!untouched()) return false;
    const parsed = normalizeApiBase(input);
    if (!parsed.ok) throw new Error(parsed.error);
    const target = parsed.url;
    const capabilities = await requireAccountsSignIn(target, serverHeaders(target));
    const probe = await probeCompatibleServer(target, capabilities.needsServerUpdate);
    if (!untouched()) return false;
    if (!probe.ok) throw new Error(probe.error);
    if (!untouched()) return false;
    await loadApiBase();
    if (!untouched()) return false;
    const saved = await saveApiBase(target, serverHeaders(target));
    if (!currentOperation()) return false;
    if (!saved.ok) throw new Error(saved.error);
    if (hasPendingServerInitialization(target)) confirmServerInitialization(target, account);
    if (!(await (capabilities.accountsLogin ? continueWithAccountsServer() : continueWithSso())))
      return false;
    if (!currentOperation() || currentApiBase() !== target) return false;
    const sessionGeneration = currentSessionGeneration();
    const me = capabilities.needsServerUpdate ? { userId: "authenticated" } : await rpc("me");
    if (
      !me.userId ||
      !currentOperation() ||
      currentApiBase() !== target ||
      currentSessionGeneration() !== sessionGeneration
    )
      return false;
    const entry = await addAccountServer(target, account);
    if (
      !currentOperation() ||
      currentApiBase() !== target ||
      currentSessionGeneration() !== sessionGeneration
    )
      return false;
    setServers((previous) => [...previous.filter((item) => item.id !== entry.id), entry]);
    setDraft("");
    return select(entry, { current: currentOperation, sessionGeneration });
  }

  async function connectPairedServer(wait: PairingWait) {
    const current = () => generation.current === wait.generation && owner.current === wait.account;
    const untouched = () =>
      current() &&
      currentApiBase() === wait.server &&
      currentSessionGeneration() === wait.sessionGeneration;
    if (!wait.approvedOrigin || wait.approvedOrigin !== wait.origin) return;
    const entries = await accountServers(wait.account);
    if (!untouched()) return;
    const entry = entries.find((value) => value.url === wait.approvedOrigin);
    if (!entry) throw new Error(t("Could not pair this server. Try again."));
    const target = entry.url;
    const capabilities = await requireAccountsSignIn(target, serverHeaders(target));
    const probe = await probeCompatibleServer(target, capabilities.needsServerUpdate);
    if (!probe.ok) throw new Error(probe.error);
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
    const me = capabilities.needsServerUpdate ? { userId: "authenticated" } : await rpc("me");
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
    if (!pairing || !pairingForeground || pending) return;
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
        if (wait.origin !== null && result.origin !== wait.origin)
          throw new Error(t("Could not pair this server. Try again."));
        if (result.status === "ready") {
          if (!wait.approvedOrigin || result.origin !== wait.approvedOrigin)
            throw new Error(t("Could not pair this server. Try again."));
          pairingRef.current = null;
          setPairing(null);
          void action(() => connectPairedServer(wait));
        } else if (result.status === "approval-required") {
          if (!result.origin || wait.approvedOrigin)
            throw new Error(t("Could not pair this server. Try again."));
          if (wait.origin === null) {
            const claimed = { ...wait, origin: result.origin };
            pairingRef.current = claimed;
            setPairing(claimed);
          } else timer = setTimeout(() => void poll(), 2_000);
        } else if (result.status === "pending" || result.status === "approved") {
          if (
            (result.status === "pending" && (wait.origin !== null || result.origin !== null)) ||
            (result.status === "approved" &&
              (!wait.approvedOrigin || result.origin !== wait.approvedOrigin))
          )
            throw new Error(t("Could not pair this server. Try again."));
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
  }, [pairing, pairingForeground, pending]);

  async function createPairing() {
    const controller = new AbortController();
    pairingRequest.current = controller;
    const current = generation.current;
    const account = owner.current;
    const server = currentApiBase();
    const sessionGeneration = currentSessionGeneration();
    try {
      const session = await beginServerPairing(account, controller.signal);
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
        origin: null,
        approvedOrigin: null,
        account,
        generation: current,
        server,
        sessionGeneration,
      };
      pairingRef.current = wait;
      setPairing(wait);
    } finally {
      if (pairingRequest.current === controller) pairingRequest.current = null;
    }
  }

  async function approvePairing(wait: PairingWait) {
    const origin = wait.origin;
    const current = () =>
      pairingRef.current === wait &&
      generation.current === wait.generation &&
      owner.current === wait.account &&
      currentApiBase() === wait.server &&
      currentSessionGeneration() === wait.sessionGeneration;
    if (!origin || wait.approvedOrigin || !current()) return;
    const controller = new AbortController();
    pairingRequest.current = controller;
    try {
      const result = await wait.session.approve(origin, controller.signal);
      if (controller.signal.aborted || !current()) return;
      if (result.status !== "approved" || result.origin !== origin)
        throw new Error(t("Could not pair this server. Try again."));
      const approved = { ...wait, approvedOrigin: origin };
      pairingRef.current = approved;
      setPairing(approved);
    } catch (failure) {
      if (current()) {
        pairingRequest.current = null;
        discardPairing();
      }
      throw failure;
    } finally {
      if (pairingRequest.current === controller) pairingRequest.current = null;
    }
  }

  if (
    phase === "ready" &&
    readyAt.version === version &&
    readyAt.attempt === attempt &&
    !linkedServer &&
    children
  )
    return serverRescue ? (
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <Text>{t("Update this server before connecting with this version of Ork.")}</Text>
        <Updates />
        <NativeActionButton
          label={t("Check again")}
          onPress={() => setAttempt((value) => value + 1)}
        />
        <NativeActionButton
          label={t("Back")}
          prominence="secondary"
          onPress={() => setPhase("servers")}
        />
      </SafeAreaView>
    ) : (
      children
    );
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
                {directory ? (
                  <WorkspaceDirectory
                    catalog={directory}
                    entries={servers}
                    organizationId={organizationId}
                    pending={pending || !!pairing}
                    onOrganization={(id) =>
                      void action(async () => {
                        const account = owner.current;
                        const current = generation.current;
                        const organization = directory.organizations.find((row) => row.id === id);
                        if (!organization) return;
                        chosenOrganization.current = { account, id };
                        setOrganizationId(id);
                        const remembered = await lastOrganizationWorkspace(account, id);
                        if (owner.current !== account || generation.current !== current) return;
                        const available = workspaceEntries(organization, servers);
                        const target = initialCatalogWorkspace(directory, id, remembered);
                        const previous =
                          target &&
                          available.find(
                            (row) =>
                              row.id === target.workspaceId &&
                              (!row.workspace || row.workspace.serverId === target.serverId),
                          );
                        if (previous) await select(previous);
                      })
                    }
                    onDefault={(id) =>
                      void action(async () => {
                        const account = owner.current;
                        const current = generation.current;
                        await setDefaultAccountOrganization(id, account);
                        if (owner.current === account && generation.current === current)
                          setDirectory((value) =>
                            value ? { ...value, defaultOrganizationId: id } : value,
                          );
                      })
                    }
                    onSelect={(entry) => void action(() => select(entry))}
                  />
                ) : null}
                {PERSONAL_SERVER_CONNECTION_ENABLED &&
                adding &&
                (linkedServer || pairing || hasPendingServerInitialization(draft)) ? (
                  <>
                    {hasPendingServerInitialization(draft) ? (
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
                    ) : null}
                    {pairing ? (
                      <>
                        {pairing.origin ? (
                          <>
                            <Text
                              selectable
                              accessibilityLabel={t("Server")}
                              style={{
                                color: tokens.foreground,
                                fontSize: 22,
                                textAlign: "center",
                              }}
                            >
                              {pairing.origin}
                            </Text>
                            {pairing.approvedOrigin ? (
                              <ActivityIndicator color={tokens.mutedForeground} />
                            ) : (
                              <NativeActionButton
                                label={t("Approve server")}
                                busy={pending}
                                onPress={() => void action(() => approvePairing(pairing))}
                              />
                            )}
                          </>
                        ) : (
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
                                ).toLocaleTimeString(undefined, {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }),
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
                          </>
                        )}
                        <NativeActionButton
                          label={t("Cancel")}
                          prominence="plain"
                          onPress={() => discardPairing()}
                        />
                      </>
                    ) : !linkedServer ||
                      hasPendingServerInitialization(draft) ||
                      linkNeedsPairing !== null ? (
                      <NativeActionButton
                        label={
                          hasPendingServerInitialization(draft) || linkNeedsPairing === false
                            ? t("Add")
                            : t("Pairing code")
                        }
                        busy={pending}
                        disabled={hasPendingServerInitialization(draft) && !draft.trim()}
                        onPress={() =>
                          void action(
                            hasPendingServerInitialization(draft) ||
                              (linkedServer === draft && linkNeedsPairing === false)
                              ? () => connectServer(draft)
                              : createPairing,
                          )
                        }
                      />
                    ) : null}
                  </>
                ) : null}
                {!linkedServer && !pairing && adding ? (
                  <>
                    <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                      {t(
                        "Install Ork on your server, then connect it in your workspace dashboard.",
                      )}
                    </Text>
                    <Text selectable style={{ color: tokens.foreground, textAlign: "center" }}>
                      {SERVER_INSTALL_COMMAND}
                    </Text>
                    <NativeActionButton
                      label={t("Copy command")}
                      prominence="secondary"
                      onPress={() =>
                        void import("expo-clipboard")
                          .then(({ setStringAsync }) => setStringAsync(SERVER_INSTALL_COMMAND))
                          .catch(() => setError(t("Could not copy the command.")))
                      }
                    />
                  </>
                ) : !linkedServer && !pairing ? (
                  <NativeActionButton
                    label={t("Self-hosted")}
                    prominence="secondary"
                    onPress={() => setAdding(true)}
                  />
                ) : null}
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
