// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createAvatar } from "@orkbot/avatar";
import type { ServerPairing, ServerPairingState } from "@orkbot/contracts";
import {
  createServerConnectLink,
  parseServerConnectLink,
  SERVER_INSTALL_COMMAND,
  SERVER_PAIRING_ALPHABET,
  SERVER_PAIRING_LIFETIME_SECONDS,
} from "@orkbot/contracts";
import { logoAvatarTraits, seededLogoAvatarColor } from "@orkbot/core/logo-avatar-traits";
import { createPersonalOrkId, isPersonalOrkId } from "@orkbot/core/personal-ork";
import { PL_MESSAGES } from "./locales/pl.js";

type Account = { userinfo: { name?: string; email?: string; ork_avatar?: string } };
type Server = { id: string; url: string; kind: "local" | "selfhosted"; isDefault?: boolean };
type StackState = { phase: string; message: string | null; output: string[] };
type Startup = {
  phase: "checking" | "opening" | "idle" | "failed";
  serverId?: string;
  kind?: Server["kind"];
  message?: string;
};
type Screen = "checking" | "welcome" | "accounts" | "servers" | "selfhost" | "local" | "opening";
type Operation =
  | "session"
  | "signin"
  | "directory"
  | "pair"
  | "approve"
  | "connect"
  | "local"
  | "logout";

export interface SetupTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, callback: (event: { payload: T }) => void): Promise<() => void>;
}

/** The bundled setup document owns presentation; native commands own every privileged effect. */
export function mountSetup(doc: Document, transport: SetupTransport) {
  const win = doc.defaultView;
  if (!win) throw new Error("Setup window unavailable");
  const t = (text: string) =>
    win.navigator.language.toLowerCase().startsWith("pl") ? (PL_MESSAGES[text] ?? text) : text;
  const element = <T extends HTMLElement>(id: string): T => {
    const found = doc.getElementById(id);
    if (!found) throw new Error(`Setup element missing: ${id}`);
    return found as T;
  };
  const shell = doc.querySelector<HTMLElement>(".shell");
  if (!shell) throw new Error("Setup shell missing");
  const input = element<HTMLInputElement>("server-url");
  const status = element("status");
  const output = element("output");
  const details = element<HTMLDetailsElement>("details");
  const servers = element("servers");
  const command = element<HTMLTextAreaElement>("install-command");
  const steps = [...doc.querySelectorAll<HTMLElement>("[data-step]")];
  const phases = [...doc.querySelectorAll<HTMLElement>("[data-phase]")];
  let account: Account | null = null;
  let pendingServer: string | null = null;
  let pendingInitialization = false;
  let pairingRequest: string | null = null;
  let pairing: ServerPairing | null = null;
  let pairingOrigin: string | null = null;
  let approvedPairingOrigin: string | null = null;
  let pairingVersion = 0;
  let pairingDeadline = 0;
  let pairingPoll: number | undefined;
  let pairingExpiry: number | undefined;
  let screen: Screen = "checking";
  let operation: Operation | null = null;
  let browserSignIn = false;
  let generation = 0;
  let disposed = false;
  let startup: Startup = { phase: "checking" };
  let failedServer: { id: string; local: boolean } | null = null;
  let directoryOwner: Account | null = null;
  let directoryServers = new Set<string>();
  let directoryReady = false;
  let directoryPolling = false;
  let directorySnapshot = "";
  const cleanups: (() => void)[] = [];
  const current = (version: number) => !disposed && generation === version;

  for (const node of doc.querySelectorAll<HTMLElement>("[data-copy]")) {
    node.textContent = t(node.dataset.copy ?? "");
  }
  doc.documentElement.lang = win.navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  for (const node of doc.querySelectorAll<HTMLElement>("[aria-label]")) {
    node.setAttribute("aria-label", t(node.getAttribute("aria-label") ?? ""));
  }
  const welcomeOrk = createPersonalOrkId();
  function renderOrk(seed: string) {
    const identity = isPersonalOrkId(seed) ? seed : welcomeOrk;
    const color = seededLogoAvatarColor(identity);
    // Only generator output reaches this sink; account strings are validated cosmetic seeds.
    element("hero").innerHTML = createAvatar({
      ...logoAvatarTraits(identity, color).appearance,
      color,
      background: "transparent",
      animate: false,
    }).svg;
  }
  renderOrk(welcomeOrk);

  function clearPairing() {
    const requestId = pairingRequest;
    pairingRequest = null;
    pairing = null;
    pairingOrigin = null;
    approvedPairingOrigin = null;
    element("pairing-origin").textContent = "";
    element("pairing-approval").hidden = true;
    element("approve-pairing").hidden = false;
    pairingVersion++;
    pairingDeadline = 0;
    win?.clearTimeout(pairingPoll);
    win?.clearTimeout(pairingExpiry);
    element<HTMLInputElement>("pairing-code").value = "";
    element("pairing").hidden = true;
    element("pairing-expires").textContent = "";
    element("copy-pairing").textContent = t("Copy");
    if (requestId)
      void transport.invoke("cancel_server_pairing", { requestId }).catch(() => undefined);
  }

  function controls() {
    for (const button of doc.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = operation !== null;
    }
    element<HTMLButtonElement>("quit").disabled = false;
    element<HTMLButtonElement>("sign-out").disabled = operation === "logout";
    element<HTMLButtonElement>("cancel-sign-in").disabled = operation === "logout";
    element<HTMLButtonElement>("back").disabled =
      screen !== "local" &&
      (startup.phase === "opening" ||
        (operation !== null &&
          operation !== "directory" &&
          operation !== "pair" &&
          operation !== "approve"));
    element("sign-out").hidden = !account;
    element("back").hidden = !["accounts", "selfhost", "local"].includes(screen);
    element("browser-hint").hidden = !browserSignIn;
    element("cancel-sign-in").hidden = operation !== "signin";
    element("sign-in").hidden = operation === "signin";
    element("retry-local").hidden =
      screen !== "local" || operation !== null || startup.phase === "opening";
    element("retry-server").hidden = screen !== "servers" || !failedServer;
    input.disabled = operation !== null;
    element("setup").hidden = !pendingInitialization;
    element("installation").hidden = pendingInitialization || !!pairingRequest;
    element("legacy-target").hidden = !pendingInitialization;
    input.readOnly = pendingInitialization;
    input.required = pendingInitialization;
    element("connect").textContent = t(pendingInitialization ? "Continue" : "New pairing key");
    element<HTMLButtonElement>("cancel-pairing").disabled = operation === "logout";
    element("approve-pairing").hidden = approvedPairingOrigin !== null;
    shell?.setAttribute("aria-busy", String(operation !== null || startup.phase === "opening"));
  }

  function show(next: Screen, focus = true) {
    if (screen !== next) {
      clearPairing();
      status.textContent = "";
      delete status.dataset.error;
      output.textContent = "";
      details.hidden = true;
      details.open = false;
    }
    screen = next;
    if (shell) shell.dataset.screen = next;
    for (const step of steps) step.hidden = step.dataset.step !== next;
    controls();
    if (focus && !doc.hidden) {
      const heading = steps.find((step) => !step.hidden)?.querySelector("h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    }
  }

  function errorMessage(error: unknown) {
    status.textContent = t(
      typeof error === "string" ? error : "Could not complete that request. Try again.",
    );
    status.dataset.error = "true";
  }

  async function run(
    kind: Operation,
    action: (version: number) => Promise<unknown>,
    failed: Screen,
  ) {
    if (operation || disposed) return;
    const version = ++generation;
    operation = kind;
    status.textContent = "";
    delete status.dataset.error;
    controls();
    try {
      await action(version);
    } catch (error) {
      if (current(version)) {
        show(account && (kind === "session" || kind === "signin") ? "servers" : failed);
        errorMessage(error);
      }
    } finally {
      if (current(version)) {
        if (kind === "signin") browserSignIn = false;
        operation = null;
        if (pendingServer && account) showPendingServer();
        controls();
      }
    }
  }

  function receivePendingServer(value: unknown) {
    const payload =
      typeof value === "object" && value !== null
        ? (value as { origin?: unknown; initialize?: unknown })
        : { origin: value };
    if (typeof payload.origin !== "string") return;
    try {
      const origin = parseServerConnectLink(createServerConnectLink(payload.origin));
      if (!origin) return;
      clearPairing();
      pendingServer = origin;
      pendingInitialization = payload.initialize === true;
      if (account && !operation) showPendingServer();
    } catch {
      // Ignore malformed native events without changing the selected server.
    }
  }

  function discardPendingServer() {
    const address = pendingServer;
    pendingServer = null;
    pendingInitialization = false;
    if (address)
      void transport.invoke("clear_server_link", { rawUrl: address }).catch(errorMessage);
  }

  function showPendingServer() {
    if (!pendingServer || !account) return;
    input.value = pendingServer;
    startup = { phase: "idle" };
    show("selfhost");
    if (pendingInitialization || operation) return;
    const origin = pendingServer;
    const owner = account;
    const linkVersion = pairingVersion;
    let unknown = false;
    let lookupVersion = 0;
    void run(
      "directory",
      async (version) => {
        lookupVersion = version;
        const active = () =>
          current(version) &&
          account === owner &&
          pendingServer === origin &&
          !pendingInitialization &&
          pairingVersion === linkVersion;
        try {
          const entries = await loadServers(version);
          if (!active()) return;
          const saved = entries.find((entry) => entry.url === origin);
          if (saved) {
            discardPendingServer();
            await openServer(
              version,
              "connect_saved_server",
              { id: saved.id },
              saved.kind === "local",
            );
          } else {
            const required = await transport.invoke<boolean>("server_initialization_required", {
              rawUrl: origin,
            });
            if (!active()) return;
            if (typeof required !== "boolean") throw "Could not complete that request. Try again.";
            discardPendingServer();
            if (required) unknown = true;
            else await openServer(version, "connect_server", { rawUrl: origin });
          }
        } catch (error) {
          if (active()) discardPendingServer();
          throw error;
        }
      },
      "selfhost",
    ).then(() => {
      if (
        unknown &&
        current(lookupVersion) &&
        account === owner &&
        pairingVersion === linkVersion &&
        !pendingServer &&
        !operation
      )
        void createPairing();
    });
  }

  async function loadServers(version: number): Promise<Server[]> {
    const entries = await transport.invoke<Server[]>("list_servers");
    if (!current(version)) return [];
    renderServers(entries);
    return entries;
  }

  function renderServers(entries: Server[]) {
    directoryOwner = account;
    directoryServers = new Set(entries.map((entry) => entry.id));
    directoryReady = true;
    directorySnapshot = JSON.stringify(entries);
    servers.replaceChildren();
    for (const entry of entries) {
      const row = doc.createElement("div");
      row.className = "server-row";
      const open = doc.createElement("button");
      open.type = "button";
      open.className = "button button-secondary server-open";
      open.textContent = entry.kind === "local" ? t("This computer") : entry.url;
      open.addEventListener("click", () => {
        void connect("connect_saved_server", { id: entry.id }, entry.kind === "local");
      });
      const preferred = doc.createElement("button");
      preferred.type = "button";
      preferred.className = "link server-default";
      preferred.textContent = entry.isDefault ? t("Default") : t("Set as default");
      preferred.setAttribute("aria-pressed", String(!!entry.isDefault));
      preferred.setAttribute("aria-label", `${t("Default server")}: ${open.textContent}`);
      preferred.addEventListener("click", () => {
        void run(
          "directory",
          async (version) => {
            await transport.invoke("set_default_server", { id: entry.isDefault ? null : entry.id });
            if (current(version)) await loadServers(version);
          },
          "servers",
        );
      });
      const remove = doc.createElement("button");
      remove.type = "button";
      remove.className = "link";
      remove.textContent = t("Remove");
      remove.setAttribute("aria-label", `${t("Remove")} ${open.textContent}`);
      remove.addEventListener("click", () => {
        void run(
          "directory",
          async (version) => {
            await transport.invoke("remove_server", { id: entry.id });
            if (current(version)) await loadServers(version);
          },
          "servers",
        );
      });
      row.append(open, preferred, remove);
      servers.append(row);
    }
    element("account").textContent =
      account?.userinfo.name ?? account?.userinfo.email ?? "Accounts";
  }

  async function refreshWaitingServers() {
    if (
      disposed ||
      doc.hidden ||
      !account ||
      operation ||
      directoryPolling ||
      pendingServer ||
      pendingInitialization ||
      pairingRequest ||
      (screen !== "servers" && screen !== "selfhost")
    )
      return;
    const owner = account;
    const version = generation;
    const activeScreen = screen;
    const previous = directoryOwner === owner && directoryReady ? directoryServers : null;
    directoryPolling = true;
    try {
      const entries = await transport.invoke<Server[]>("list_servers");
      if (
        !current(version) ||
        account !== owner ||
        operation ||
        screen !== activeScreen ||
        pendingServer ||
        pendingInitialization ||
        pairingRequest
      )
        return;
      const found =
        previous !== null &&
        entries.some((entry) => entry.kind === "selfhosted" && !previous.has(entry.id));
      if (directoryOwner !== owner || JSON.stringify(entries) !== directorySnapshot)
        renderServers(entries);
      if (found && activeScreen === "selfhost") show("servers");
    } catch {
      // A directory outage does not interrupt the current setup screen.
    } finally {
      directoryPolling = false;
    }
  }

  const directoryTimer = win.setInterval(() => void refreshWaitingServers(), 15_000);
  cleanups.push(() => win.clearInterval(directoryTimer));

  async function openServer(
    version: number,
    name: string,
    args?: Record<string, unknown>,
    local = false,
  ) {
    failedServer = null;
    for (const phase of phases) {
      delete phase.dataset.state;
      phase.removeAttribute("aria-current");
    }
    operation = local ? "local" : "connect";
    show(local ? "local" : "opening");
    try {
      await transport.invoke(name, args);
    } catch (error) {
      if (current(version) && name === "connect_saved_server" && typeof args?.id === "string") {
        failedServer = { id: args.id, local };
      }
      throw error;
    }
    if (!current(version)) return;
    // Native hides setup after activation; leave explicit reopening at the picker.
    show("servers", false);
    await loadServers(version);
  }

  async function connect(name: string, args?: Record<string, unknown>, local = false) {
    if (!account || operation) return;
    startup = { phase: "idle" };
    await run(
      local ? "local" : "connect",
      (version) => openServer(version, name, args, local),
      local ? "local" : name === "connect_saved_server" ? "servers" : "selfhost",
    );
  }

  function startupScreen() {
    if (startup.phase === "checking") show("checking", false);
    else if (startup.phase === "opening")
      show(startup.kind === "local" ? "local" : "opening", false);
    else {
      show("servers", false);
      if (startup.phase === "failed") {
        failedServer = startup.serverId
          ? { id: startup.serverId, local: startup.kind === "local" }
          : null;
        errorMessage(startup.message);
        controls();
      }
    }
  }

  function expirePairing() {
    clearPairing();
    status.textContent = t("The pairing key has expired. Create a new one.");
  }

  async function pollPairing(value: ServerPairing, requestId: string, version: number) {
    const active = () =>
      !disposed &&
      screen === "selfhost" &&
      !!account &&
      pairing === value &&
      pairingRequest === requestId &&
      pairingVersion === version;
    if (!active()) return;
    if (pairingDeadline <= Date.now()) {
      expirePairing();
      return;
    }
    try {
      const result = await transport.invoke<ServerPairingState>("get_server_pairing", {
        requestId,
      });
      if (!active()) return;
      if (result.expiresAt !== value.expiresAt) throw new Error("Invalid pairing state");
      const origin =
        typeof result.origin === "string"
          ? parseServerConnectLink(createServerConnectLink(result.origin))
          : null;
      if (result.origin !== origin || (pairingOrigin && origin && pairingOrigin !== origin))
        throw new Error("Invalid pairing origin");
      if (pairingDeadline <= Date.now() || result.status === "expired") {
        expirePairing();
        return;
      }
      if (result.status === "failed") {
        clearPairing();
        errorMessage("Could not complete that request. Try again.");
        return;
      }
      if (result.status === "approval-required") {
        if (!origin) throw new Error("Missing pairing origin");
        pairingOrigin = origin;
        element("pairing-origin").textContent = origin;
        element("pairing-approval").hidden = false;
        controls();
      } else if (result.status === "approved" || result.status === "ready") {
        if (!approvedPairingOrigin || origin !== approvedPairingOrigin)
          throw new Error("Pairing not approved");
      } else if (result.status !== "pending" || origin !== null || pairingOrigin !== null) {
        throw new Error("Invalid pairing state");
      }
      if (result.status === "ready") {
        const origin = approvedPairingOrigin;
        clearPairing();
        const completionVersion = pairingVersion;
        await run(
          "connect",
          async (generation) => {
            const entries = await loadServers(generation);
            if (!current(generation) || pairingVersion !== completionVersion) return;
            const selected = entries.find(
              (entry) => entry.kind === "selfhosted" && entry.url === origin,
            );
            if (!selected) throw "Could not complete that request. Try again.";
            await openServer(generation, "connect_saved_server", { id: selected.id });
          },
          "selfhost",
        );
        return;
      }
      status.textContent = "";
    } catch {
      if (!active()) return;
      errorMessage("Could not complete that request. Try again.");
    }
    if (active())
      pairingPoll = win?.setTimeout(() => void pollPairing(value, requestId, version), 2000);
  }

  async function createPairing() {
    if (!account || operation || screen !== "selfhost" || pendingInitialization) return;
    discardPendingServer();
    clearPairing();
    const requestId = createPersonalOrkId();
    pairingRequest = requestId;
    const version = pairingVersion;
    await run(
      "pair",
      async (generation) => {
        const value = await transport.invoke<ServerPairing>("create_server_pairing", {
          requestId,
        });
        if (
          !current(generation) ||
          pairingRequest !== requestId ||
          version !== pairingVersion ||
          screen !== "selfhost"
        )
          return;
        if (
          !/^[a-f0-9]{64}$/.test(value.id) ||
          value.code.length !== 6 ||
          [...value.code].some((char) => !SERVER_PAIRING_ALPHABET.includes(char)) ||
          !Number.isSafeInteger(value.expiresAt)
        )
          throw "Could not complete that request. Try again.";
        const expires = Math.min(
          value.expiresAt * 1000,
          Date.now() + SERVER_PAIRING_LIFETIME_SECONDS * 1000,
        );
        if (expires <= Date.now()) {
          expirePairing();
          return;
        }
        pairing = value;
        pairingDeadline = expires;
        element<HTMLInputElement>("pairing-code").value = value.code;
        element("pairing").hidden = false;
        element("pairing-expires").textContent =
          `${t("Valid until")} ${new Date(expires).toLocaleTimeString(doc.documentElement.lang, { hour: "2-digit", minute: "2-digit" })}`;
        pairingExpiry = win?.setTimeout(expirePairing, expires - Date.now());
        pairingPoll = win?.setTimeout(() => void pollPairing(value, requestId, version), 2000);
      },
      "selfhost",
    );
    if (pairingRequest === requestId && !pairing) clearPairing();
  }

  async function approvePairing() {
    const value = pairing;
    const origin = pairingOrigin;
    const requestId = pairingRequest;
    const version = pairingVersion;
    if (
      !account ||
      operation ||
      !value ||
      !origin ||
      !requestId ||
      approvedPairingOrigin ||
      pairingDeadline <= Date.now()
    )
      return;
    await run(
      "approve",
      async (generation) => {
        const result = await transport.invoke<ServerPairingState>("approve_server_pairing", {
          requestId,
          origin,
        });
        if (
          !current(generation) ||
          pairing !== value ||
          pairingRequest !== requestId ||
          pairingVersion !== version ||
          pairingOrigin !== origin
        )
          return;
        if (
          result.status !== "approved" ||
          result.origin !== origin ||
          result.expiresAt !== value.expiresAt ||
          pairingDeadline <= Date.now()
        )
          throw "Could not complete that request. Try again.";
        approvedPairingOrigin = origin;
        status.textContent = "";
        controls();
      },
      "selfhost",
    );
  }

  const on = (id: string, event: string, listener: EventListener) => {
    const target = element(id);
    target.addEventListener(event, listener);
    cleanups.push(() => target.removeEventListener(event, listener));
  };
  async function continueAccount(version: number, value: Account) {
    if (!current(version)) return;
    account = value;
    renderOrk(value.userinfo.ork_avatar ?? welcomeOrk);
    if (pendingServer) {
      showPendingServer();
      return;
    }
    if (startup.phase !== "idle") {
      startupScreen();
      if (startup.phase === "failed") await loadServers(version);
      return;
    }
    const entries = await loadServers(version);
    if (!current(version)) return;
    if (pendingServer) {
      showPendingServer();
      return;
    }
    const selected =
      entries.find((entry) => entry.isDefault) ?? (entries.length === 1 ? entries[0] : undefined);
    if (selected)
      await openServer(
        version,
        "connect_saved_server",
        { id: selected.id },
        selected.kind === "local",
      );
    else show("servers");
  }

  async function signIn(restoreSession = false) {
    if (operation || disposed) return;
    show("accounts");
    await run(
      "signin",
      async (version) => {
        const restored = restoreSession
          ? await transport.invoke<Account | null>("setup_accounts_session")
          : null;
        if (!current(version)) return;
        let value = restored;
        if (!value) {
          browserSignIn = true;
          controls();
          value = await transport.invoke<Account>("setup_accounts_sign_in", {
            orkAvatar: welcomeOrk,
          });
        }
        if (!current(version)) return;
        if (!restored) startup = { phase: "idle" };
        await continueAccount(version, value);
      },
      "accounts",
    );
  }
  on("get-started", "click", () => {
    if (!account) void signIn(true);
  });
  on("sign-in", "click", () => void signIn());
  function chooseServer() {
    if (disposed) return;
    discardPendingServer();
    generation++;
    operation = null;
    startup = { phase: "idle" };
    show(account ? "servers" : "welcome");
    if (account)
      void run(
        "directory",
        async (version) => {
          await transport.invoke("cancel_setup_connection");
          if (current(version)) await loadServers(version);
        },
        "servers",
      );
  }
  on("back", "click", () => {
    if (screen === "local") {
      chooseServer();
      return;
    }
    if (
      !operation ||
      operation === "directory" ||
      operation === "pair" ||
      operation === "approve"
    ) {
      discardPendingServer();
      generation++;
      operation = null;
      show(account ? "servers" : "welcome");
    }
  });
  on("selfhost", "click", () => {
    if (account && !operation) {
      show("selfhost");
    }
  });
  on("local", "click", () => void connect("connect_local_server", undefined, true));
  on("retry-local", "click", () => void connect("connect_local_server", undefined, true));
  on("retry-server", "click", () => {
    if (failedServer)
      void connect("connect_saved_server", { id: failedServer.id }, failedServer.local);
  });
  on("refresh", "click", () => void run("directory", loadServers, "servers"));
  on("setup", "submit", (event) => {
    event.preventDefault();
    if (!pendingInitialization || !input.reportValidity() || input.value !== pendingServer) {
      errorMessage("Could not complete that request. Try again.");
      return;
    }
    pendingServer = null;
    pendingInitialization = false;
    void connect("connect_server", { rawUrl: input.value });
  });
  async function logout() {
    if (operation === "logout" || disposed) return;
    discardPendingServer();
    generation++;
    account = null;
    failedServer = null;
    startup = { phase: "idle" };
    renderOrk(welcomeOrk);
    operation = null;
    browserSignIn = false;
    input.value = "";
    element("account").textContent = "";
    servers.replaceChildren();
    clearPairing();
    show("welcome");
    await run(
      "logout",
      async () => {
        await transport.invoke("setup_accounts_logout");
      },
      "welcome",
    );
  }
  on("sign-out", "click", () => void logout());
  on("cancel-sign-in", "click", () => void logout());
  on("quit", "click", () => {
    clearPairing();
    void transport.invoke("quit_setup").catch(errorMessage);
  });
  on("copy-pairing", "click", () => {
    const value = pairing;
    const version = pairingVersion;
    if (!value || pairingDeadline <= Date.now()) {
      if (value) expirePairing();
      return;
    }
    void Promise.resolve()
      .then(() => {
        if (disposed || pairing !== value || pairingVersion !== version) return;
        return win?.navigator.clipboard?.writeText(value.code) ?? Promise.reject();
      })
      .then(() => {
        if (!disposed && pairing === value && pairingVersion === version)
          element("copy-pairing").textContent = t("Copied");
      })
      .catch(() => {
        if (disposed || pairing !== value || pairingVersion !== version) return;
        const input = element<HTMLInputElement>("pairing-code");
        input.focus();
        input.select();
      });
  });
  on("approve-pairing", "click", () => void approvePairing());
  on("cancel-pairing", "click", () => {
    generation++;
    operation = null;
    clearPairing();
    controls();
  });
  command.value = SERVER_INSTALL_COMMAND;
  on("copy", "click", () => {
    void Promise.resolve()
      .then(() => win.navigator.clipboard?.writeText(command.value) ?? Promise.reject())
      .then(() => {
        if (!disposed) element("copy").textContent = t("Copied");
      })
      .catch(() => {
        if (disposed) return;
        command.focus();
        command.select();
        status.textContent = t("Select and copy the command.");
      });
  });

  show("checking", false);
  void run(
    "session",
    async (version) => {
      const stopStack = await transport.listen<StackState>(
        "desktop-stack-changed",
        ({ payload }) => {
          if (
            disposed ||
            !account ||
            screen !== "local" ||
            (operation !== "local" && startup.phase !== "opening")
          )
            return;
          const index =
            payload.phase === "ready"
              ? phases.length
              : phases.findIndex((phase) => phase.dataset.phase === payload.phase);
          if (index >= 0)
            for (let i = 0; i < phases.length; i++) {
              const phase = phases[i];
              if (phase) {
                phase.dataset.state = i < index ? "done" : i === index ? "current" : "pending";
                if (i === index) phase.setAttribute("aria-current", "step");
                else phase.removeAttribute("aria-current");
              }
            }
          status.textContent = payload.message ? t(payload.message) : "";
          output.textContent = payload.output.join("\n");
          details.hidden = payload.output.length === 0;
          if (payload.phase === "ready") show("opening");
        },
      );
      if (!current(version)) {
        stopStack();
        return;
      }
      cleanups.push(stopStack);
      const stopStartup = await transport.listen<Startup>(
        "desktop-startup-changed",
        ({ payload }) => {
          if (disposed) return;
          startup = payload;
          if (!account || operation === "signin" || operation === "logout") return;
          if (operation && operation !== "session") return;
          startupScreen();
          if (payload.phase === "idle" || payload.phase === "failed") {
            if (!operation)
              void run(
                "directory",
                async (version) => {
                  await loadServers(version);
                  if (current(version) && payload.phase === "failed") errorMessage(payload.message);
                },
                "servers",
              );
          }
        },
      );
      if (!current(version)) {
        stopStartup();
        return;
      }
      cleanups.push(stopStartup);
      const stopChooseServer = await transport.listen("desktop-change-server", () =>
        chooseServer(),
      );
      if (!current(version)) {
        stopChooseServer();
        return;
      }
      cleanups.push(stopChooseServer);
      const stopLinks = await transport.listen<string>("desktop-server-link", ({ payload }) => {
        if (!disposed) receivePendingServer(payload);
      });
      if (!current(version)) {
        stopLinks();
        return;
      }
      cleanups.push(stopLinks);
      const state = await transport.invoke<{
        startup?: Startup;
        pendingServer?: string;
        initializingServer?: string;
      } | null>("setup_state");
      if (!current(version)) return;
      receivePendingServer({
        origin: state?.pendingServer,
        initialize: state?.initializingServer === state?.pendingServer,
      });
      startup = state?.startup ?? { phase: "idle" };
      // Restoring a verified session never opens browser sign-in. New users continue explicitly.
      const restored = await transport.invoke<Account | null>("setup_accounts_session");
      if (!current(version)) return;
      if (restored) await continueAccount(version, restored);
      else show("welcome", false);
    },
    "welcome",
  );

  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    clearPairing();
    for (const cleanup of cleanups) cleanup();
    servers.replaceChildren();
  };
}
