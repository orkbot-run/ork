// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createAvatar } from "@orkbot/avatar";
import type { ServerPairing, ServerPairingState } from "@orkbot/contracts";
import {
  createServerConnectLink,
  parseServerConnectLink,
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
type Installation = { id: string; command: string; expiresAt: string; url: string | null };
type InstallationStatus = {
  id: string;
  url: string | null;
  phase:
    | "waiting"
    | "preparing"
    | "pulling"
    | "starting"
    | "waiting-healthy"
    | "ready"
    | "failed"
    | "expired";
  expiresAt: string;
};
type Screen = "checking" | "welcome" | "accounts" | "servers" | "selfhost" | "local" | "opening";
type Operation =
  | "session"
  | "signin"
  | "directory"
  | "install"
  | "pair"
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
  let expiryTimer: number | undefined;
  let pollTimer: number | undefined;
  let installation: Installation | null = null;
  let installationVersion = 0;
  let installing = false;
  let copyDeadline = 0;
  let installationDeadline = 0;
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

  function clearInstallation() {
    win?.clearTimeout(expiryTimer);
    win?.clearTimeout(pollTimer);
    installationVersion++;
    installation = null;
    installing = false;
    copyDeadline = 0;
    installationDeadline = 0;
    command.value = "";
    element("installation").hidden = true;
    element("installation-status").textContent = "";
    element("expires").textContent = "";
    element("copy").textContent = t("Copy command");
    element("create-installation").hidden = false;
  }

  function controls() {
    for (const button of doc.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = operation !== null;
    }
    element<HTMLButtonElement>("quit").disabled = false;
    element<HTMLButtonElement>("sign-out").disabled = operation === "logout";
    element<HTMLButtonElement>("cancel-sign-in").disabled = operation === "logout";
    element<HTMLButtonElement>("back").disabled =
      startup.phase === "opening" ||
      (operation !== null && operation !== "install" && operation !== "pair");
    element("sign-out").hidden = !account;
    element("back").hidden = !["accounts", "selfhost", "local"].includes(screen);
    element("browser-hint").hidden = !browserSignIn;
    element("cancel-sign-in").hidden = operation !== "signin";
    element("sign-in").hidden = operation === "signin";
    element("retry-local").hidden =
      screen !== "local" || operation !== null || startup.phase === "opening";
    element("retry-server").hidden = screen !== "servers" || !failedServer;
    input.disabled = operation !== null;
    element("connect").textContent = t(pendingInitialization ? "Continue" : "Pairing key");
    shell?.setAttribute("aria-busy", String(operation !== null || startup.phase === "opening"));
  }

  function show(next: Screen, focus = true) {
    if (screen !== next) {
      clearPairing();
      clearInstallation();
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
    if (!pendingServer) return;
    input.value = pendingServer;
    startup = { phase: "idle" };
    show("selfhost");
  }

  async function loadServers(version: number): Promise<Server[]> {
    const entries = await transport.invoke<Server[]>("list_servers");
    if (!current(version)) return [];
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
    return entries;
  }

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
      if (result.origin !== value.origin || result.expiresAt !== value.expiresAt)
        throw new Error("Invalid pairing state");
      if (pairingDeadline <= Date.now() || result.status === "expired") {
        expirePairing();
        return;
      }
      if (result.status === "failed") {
        clearPairing();
        errorMessage("Could not complete that request. Try again.");
        return;
      }
      if (result.status === "ready") {
        const origin = value.origin;
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
      if (result.status !== "pending") throw new Error("Invalid pairing state");
      status.textContent = "";
    } catch {
      if (!active()) return;
      errorMessage("Could not complete that request. Try again.");
    }
    if (active())
      pairingPoll = win?.setTimeout(() => void pollPairing(value, requestId, version), 2000);
  }

  async function createPairing() {
    if (!account || operation || screen !== "selfhost") return;
    clearPairing();
    clearInstallation();
    const requestId = createPersonalOrkId();
    pairingRequest = requestId;
    const version = pairingVersion;
    await run(
      "pair",
      async (generation) => {
        const value = await transport.invoke<ServerPairing>("create_server_pairing", {
          rawUrl: input.value,
          requestId,
        });
        if (
          !current(generation) ||
          pairingRequest !== requestId ||
          version !== pairingVersion ||
          screen !== "selfhost"
        )
          return;
        const origin = parseServerConnectLink(createServerConnectLink(input.value));
        if (
          value.origin !== origin ||
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
        input.value = value.origin;
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

  function expireInstallation() {
    clearInstallation();
    element("installation-status").textContent = t(
      "The install command has expired. Create a new one.",
    );
  }

  async function pollInstallation(value: Installation, version: number) {
    const active = () =>
      !disposed &&
      screen === "selfhost" &&
      !!account &&
      installation === value &&
      installationVersion === version;
    if (!active()) return;
    if (installationDeadline <= Date.now()) {
      expireInstallation();
      return;
    }
    try {
      const result = await transport.invoke<InstallationStatus>("get_server_installation", {
        id: value.id,
      });
      if (!active()) return;
      if (result.id !== value.id) throw new Error("Unexpected installation");
      if (result.phase === "expired") {
        expireInstallation();
        return;
      }
      const deadline = Date.parse(result.expiresAt);
      if (!Number.isFinite(deadline)) throw new Error("Invalid installation deadline");
      installationDeadline = Math.min(deadline, Date.now() + 3_600_000);
      win?.clearTimeout(expiryTimer);
      expiryTimer = win?.setTimeout(
        expireInstallation,
        Math.max(0, installationDeadline - Date.now()),
      );
      if (result.phase === "failed") {
        installing = false;
        copyDeadline = Date.parse(result.expiresAt);
        command.value = value.command;
        element("installation").hidden = false;
        element("expires").textContent = "";
        element("create-installation").hidden = true;
      } else if (result.phase !== "waiting") {
        installing = true;
        command.value = "";
        element("installation").hidden = true;
        element("create-installation").hidden = true;
      }
      const copy: Record<InstallationStatus["phase"], string> = {
        waiting: "Run the command on your Linux server.",
        preparing: "Prepare server",
        pulling: "Download Ork",
        starting: "Start services",
        "waiting-healthy": "Wait for server",
        ready: "Opening Ork...",
        failed: "Server setup failed. Run the command again on your server.",
        expired: "The install command has expired. Create a new one.",
      };
      element("installation-status").textContent = t(copy[result.phase]);
      if (result.phase === "ready") {
        if (!result.url) throw new Error("Missing server URL");
        input.value = result.url;
        await connect("connect_server", { rawUrl: result.url });
        return;
      }
      if (installationDeadline <= Date.now()) {
        expireInstallation();
        return;
      }
    } catch {
      if (!active()) return;
      if (installationDeadline <= Date.now()) {
        expireInstallation();
        return;
      }
      element("installation-status").textContent = t("Could not check setup. Retrying...");
    }
    if (active()) pollTimer = win?.setTimeout(() => void pollInstallation(value, version), 3000);
  }

  async function createInstallation() {
    if (!account || operation || screen !== "selfhost") return;
    clearInstallation();
    await run(
      "install",
      async (version) => {
        const value = await transport.invoke<Installation>("create_server_installation");
        if (!current(version) || screen !== "selfhost") return;
        const expires = Date.parse(value.expiresAt);
        if (!value.id || !value.command || !Number.isFinite(expires) || expires <= Date.now()) {
          throw "The install command has expired. Create a new one.";
        }
        installation = value;
        copyDeadline = expires;
        installationDeadline = expires;
        command.value = value.command;
        element("installation").hidden = false;
        element("create-installation").hidden = true;
        element("expires").textContent =
          `${t("Valid until")} ${new Date(expires).toLocaleTimeString(doc.documentElement.lang, { hour: "2-digit", minute: "2-digit" })}`;
        element("installation-status").textContent = t("Run the command on your Linux server.");
        expiryTimer = win?.setTimeout(
          expireInstallation,
          Math.min(expires - Date.now(), 2_147_483_647),
        );
        pollTimer = win?.setTimeout(() => void pollInstallation(value, installationVersion), 3000);
      },
      "selfhost",
    );
  }

  const on = (id: string, event: string, listener: EventListener) => {
    const target = element(id);
    target.addEventListener(event, listener);
    cleanups.push(() => target.removeEventListener(event, listener));
  };
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
        account = value;
        if (!restored) startup = { phase: "idle" };
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
          entries.find((entry) => entry.isDefault) ??
          (entries.length === 1 ? entries[0] : undefined);
        if (selected)
          await openServer(
            version,
            "connect_saved_server",
            { id: selected.id },
            selected.kind === "local",
          );
        else show("servers");
      },
      "accounts",
    );
  }
  on("get-started", "click", () => void signIn(true));
  on("sign-in", "click", () => void signIn());
  on("back", "click", () => {
    if (!operation || operation === "install" || operation === "pair") {
      discardPendingServer();
      generation++;
      operation = null;
      show(account ? "servers" : "welcome");
    }
  });
  on("selfhost", "click", () => {
    if (account && !operation) {
      show("selfhost");
      void createInstallation();
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
    if (input.reportValidity()) {
      if (pendingInitialization && input.value === pendingServer) {
        pendingServer = null;
        pendingInitialization = false;
        void connect("connect_server", { rawUrl: input.value });
      } else {
        pendingServer = null;
        pendingInitialization = false;
        void createPairing();
      }
    }
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
    clearInstallation();
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
    clearInstallation();
    void transport.invoke("quit_setup").catch(errorMessage);
  });
  on("server-url", "input", () => {
    clearPairing();
    if (input.value !== pendingServer) pendingInitialization = false;
    controls();
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
  on("create-installation", "click", () => void createInstallation());
  on("copy", "click", () => {
    const value = installation;
    if (!value || installing || copyDeadline <= Date.now()) {
      if (value && !installing) expireInstallation();
      return;
    }
    const version = installationVersion;
    const text = command.value;
    void Promise.resolve()
      .then(() => {
        if (disposed || installationVersion !== version || installation !== value) return;
        return win?.navigator.clipboard?.writeText(text) ?? Promise.reject();
      })
      .then(() => {
        if (!disposed && installationVersion === version && installation === value)
          element("copy").textContent = t("Copied");
      })
      .catch(() => {
        if (disposed || installationVersion !== version || installation !== value) return;
        command.focus();
        command.select();
        status.textContent = t("Select and copy the command.");
      });
  });

  show("welcome", false);
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
      show("welcome", false);
    },
    "welcome",
  );

  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    clearPairing();
    clearInstallation();
    for (const cleanup of cleanups) cleanup();
    servers.replaceChildren();
  };
}
