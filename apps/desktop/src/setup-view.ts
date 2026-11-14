// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createAvatar } from "@orkbot/avatar";
import type {
  IdentityCatalog,
  ServerPairing,
  ServerPairingState,
  WorkspaceTarget,
} from "@orkbot/contracts";
import {
  catalogWorkspace,
  createServerConnectLink,
  identityCatalogSchema,
  initialCatalogOrganization,
  parseServerConnectLink,
  SERVER_INSTALL_COMMAND,
  SERVER_PAIRING_ALPHABET,
  SERVER_PAIRING_LIFETIME_SECONDS,
  WorkspaceTargetSchema,
} from "@orkbot/contracts";
import { logoAvatarTraits, seededLogoAvatarColor } from "@orkbot/core/logo-avatar-traits";
import { createPersonalOrkId, isPersonalOrkId } from "@orkbot/core/personal-ork";
import { PL_MESSAGES } from "./locales/pl.js";
import { desktopWorkspaceRoute, renderWorkspacePicker } from "./workspace-picker.js";

type WorkspaceLink = Pick<WorkspaceTarget, "organizationId" | "serverId" | "workspaceId">;
const workspaceLinkSchema = WorkspaceTargetSchema.pick({
  organizationId: true,
  serverId: true,
  workspaceId: true,
});

type Account = { userinfo: { name?: string; email?: string; ork_avatar?: string } };
type Server = { id: string; url: string; kind: "local" | "selfhosted"; isDefault?: boolean };
type Workspace = { id: string; name: string; url: string };
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
  const workspaces = element("workspaces");
  const command = element<HTMLTextAreaElement>("install-command");
  const steps = [...doc.querySelectorAll<HTMLElement>("[data-step]")];
  const phases = [...doc.querySelectorAll<HTMLElement>("[data-phase]")];
  let account: Account | null = null;
  let accountEpoch = 0;
  let pendingServer: string | null = null;
  let pendingWorkspace: WorkspaceLink | null = null;
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
  let directoryStage: "organization" | "servers" | "location" = "organization";
  let waitingServerIds: Set<string> | null = null;
  let waitingWorkspaceIds: Set<string> | null = null;
  let operation: Operation | null = null;
  let browserSignIn = false;
  let generation = 0;
  let disposed = false;
  let startup: Startup = { phase: "checking" };
  let failedServer: {
    id: string;
    local: boolean;
    command: "connect_saved_server" | "connect_workspace";
  } | null = null;
  let organizationCount: number | null = null;
  let workspaceSnapshot = "";
  let workspaceCatalog: IdentityCatalog | null = null;
  let workspaceEntries: Workspace[] = [];
  let selectedOrganizationId: string | null | undefined;
  let workspaceProbeGeneration = 0;
  let directoryOwner: Account | null = null;
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
      button.disabled = operation !== null || button.dataset.unavailable === "true";
    }
    element<HTMLButtonElement>("sign-out").disabled = operation === "logout";
    element<HTMLButtonElement>("cancel-sign-in").disabled = operation === "logout";
    element<HTMLButtonElement>("back").disabled =
      screen !== "local" &&
      (startup.phase === "opening" ||
        (operation !== null &&
          operation !== "directory" &&
          operation !== "pair" &&
          operation !== "approve"));
    element("account-menu").hidden = !account;
    element("sign-out").hidden = !account;
    element("back").hidden =
      !["accounts", "selfhost", "local"].includes(screen) &&
      !(
        screen === "servers" &&
        (directoryStage === "location" || (directoryStage === "servers" && !!organizationCount))
      );
    element("organization-next").hidden =
      screen !== "servers" || directoryStage !== "organization" || !organizationCount;
    element<HTMLButtonElement>("organization-next").disabled =
      operation !== null || !selectedOrganizationId;
    element("add-server").hidden = directoryStage !== "servers";
    element("saved-servers").hidden = directoryStage !== "servers";
    element("server-choices").hidden = directoryStage !== "location";
    element("workspaces-section").hidden = !organizationCount || directoryStage === "location";
    element("workspaces-error").hidden =
      organizationCount !== null || directoryStage === "location";
    for (const node of workspaces.querySelectorAll<HTMLElement>("[data-directory-group]"))
      node.hidden = node.dataset.directoryGroup !== directoryStage;
    element("directory-title").textContent = t(
      directoryStage === "organization"
        ? "Choose organization"
        : directoryStage === "servers"
          ? "Choose server"
          : "Where will Ork live?",
    );
    element("directory-description").textContent = t(
      directoryStage === "organization"
        ? "Choose an organization to continue."
        : directoryStage === "servers"
          ? "Choose a server or add a new one."
          : "Choose where to run Ork.",
    );
    shell!.dataset.directoryStage = directoryStage;
    element("browser-hint").hidden = !browserSignIn;
    element("cancel-sign-in").hidden = operation !== "signin";
    element("sign-in").hidden = operation === "signin";
    element("retry-local").hidden =
      screen !== "local" || operation !== null || startup.phase === "opening";
    element("retry-server").hidden =
      screen !== "servers" || directoryStage !== "servers" || !failedServer;
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
    if (screen === "local") {
      const failedPhase = phases.find((phase) => phase.dataset.state === "current") ?? phases[0];
      if (failedPhase) {
        failedPhase.dataset.state = "error";
        failedPhase.removeAttribute("aria-current");
      }
    }
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

  function receivePendingWorkspace(value: unknown) {
    const parsed = workspaceLinkSchema.safeParse(value);
    if (!parsed.success || disposed) return;
    pendingWorkspace = parsed.data;
    failedServer = null;
    pendingServer = null;
    pendingInitialization = false;
    startup = { phase: "idle" };
    if (account) {
      generation++;
      operation = null;
      void run("directory", (version) => openPendingWorkspace(version), "servers");
    }
  }

  async function clearPendingWorkspace() {
    const pending = pendingWorkspace;
    if (!pending) return;
    pendingWorkspace = null;
    await transport.invoke("clear_workspace_link", { target: pending });
  }

  async function openPendingWorkspace(version: number) {
    const pending = pendingWorkspace;
    const owner = account;
    if (!pending || !owner) return;
    selectedOrganizationId = pending.organizationId;
    await loadServers(version);
    if (!current(version) || account !== owner || pendingWorkspace !== pending) return;
    const choice = workspaceCatalog && catalogWorkspace(workspaceCatalog, pending);
    if (!choice || !desktopWorkspaceRoute(choice.server.routes)) throw "Workspace unavailable";
    await openServer(version, "connect_workspace", { id: pending.workspaceId, link: pending });
    if (current(version) && pendingWorkspace === pending) pendingWorkspace = null;
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
      pendingWorkspace = null;
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
    // Personal server links are disabled while workspaces own remote connections.
    discardPendingServer();
    show("servers");
    if (operation) {
      const version = generation;
      void loadServers(version).catch((error) => {
        if (current(version)) errorMessage(error);
      });
    } else void run("directory", loadServers, "servers");
    /*
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
        void _createPairing();
    });
    */
  }

  async function loadWorkspaces(version: number, owner: Account | null, refreshStatus = false) {
    let timeout: number | undefined;
    try {
      const raw = await Promise.race([
        transport.invoke<IdentityCatalog>("workspace_catalog"),
        new Promise<never>((_, reject) => {
          timeout = win?.setTimeout(() => reject(new Error("Workspace directory timed out")), 4000);
        }),
      ]);
      if (!current(version) || account !== owner) return;
      const catalog = identityCatalogSchema.parse(raw);
      workspaceCatalog = catalog;
      if (selectedOrganizationId === undefined)
        selectedOrganizationId = initialCatalogOrganization(catalog)?.id ?? null;
      organizationCount = catalog.organizations.length;
      if (organizationCount === 0 && directoryStage === "organization") directoryStage = "servers";
      element("workspaces-error").hidden = true;
      element("workspaces-section").hidden = catalog.organizations.length === 0;
      const snapshot = JSON.stringify([catalog, selectedOrganizationId]);
      if (snapshot === workspaceSnapshot) {
        if (refreshStatus) checkWorkspaces(workspaceEntries, version, owner, snapshot);
        return;
      }
      workspaceSnapshot = snapshot;
      renderWorkspaces(version, owner);
    } catch {
      if (!current(version) || account !== owner) return;
      workspaceProbeGeneration++;
      organizationCount = null;
      workspaceSnapshot = "";
      workspaces.replaceChildren();
      element("workspaces-section").hidden = true;
      element("workspaces-error").hidden = false;
      if (directoryStage === "organization") directoryStage = "servers";
      controls();
    } finally {
      win?.clearTimeout(timeout);
    }
  }

  function renderWorkspaces(version: number, owner: Account | null) {
    if (!workspaceCatalog || !current(version) || account !== owner) return;
    const epoch = accountEpoch;
    const snapshot = workspaceSnapshot;
    const active = () =>
      !disposed && accountEpoch === epoch && account === owner && workspaceSnapshot === snapshot;
    const valid = renderWorkspacePicker({
      document: doc,
      container: workspaces,
      catalog: workspaceCatalog,
      organizationId: selectedOrganizationId ?? null,
      t,
      chooseOrganization: (id) => {
        if (!active()) return;
        void clearPendingWorkspace().catch((error) => {
          if (accountEpoch === epoch && account === owner && !disposed) errorMessage(error);
        });
        failedServer = null;
        selectedOrganizationId = id;
        workspaceSnapshot = JSON.stringify([workspaceCatalog, id]);
        renderWorkspaces(generation, owner);
      },
      setDefaultOrganization: (organizationId) => {
        if (!active()) return;
        void run(
          "directory",
          async (next) => {
            await transport.invoke("set_default_organization", { organizationId });
            if (current(next) && account === owner) await loadWorkspaces(next, owner);
          },
          "servers",
        );
      },
      open: (id) => {
        if (active()) void connect("connect_workspace", { id });
      },
    });
    workspaceEntries = valid;
    controls();
    checkWorkspaces(valid, version, owner, workspaceSnapshot);
  }

  function setWorkspaceStatus(
    label: HTMLElement,
    state: "checking" | "online" | "offline" | "unknown",
  ) {
    const details = {
      checking: ["Checking", "Checking server status"],
      online: ["Online", "Server online"],
      offline: ["Offline", "Server unavailable or unreachable. Refresh or contact an admin."],
      unknown: ["Unknown", "Server status unavailable"],
    } as const;
    label.dataset.status = state;
    label.textContent = t(details[state][0]);
    label.title = t(details[state][1]);
    label.setAttribute("aria-label", t(details[state][1]));
  }

  function checkWorkspaces(
    entries: Workspace[],
    version: number,
    owner: Account | null,
    snapshot: string,
  ) {
    const probe = ++workspaceProbeGeneration;
    let index = 0;
    const active = () =>
      current(version) &&
      account === owner &&
      workspaceSnapshot === snapshot &&
      workspaceProbeGeneration === probe;
    async function worker() {
      while (active() && index < entries.length) {
        const entry = entries[index++];
        if (!entry) return;
        const label = [...workspaces.querySelectorAll<HTMLElement>(".workspace-availability")].find(
          (node) => node.dataset.workspaceId === entry.id,
        );
        if (!label) continue;
        setWorkspaceStatus(label, "checking");
        try {
          const online = await transport.invoke<boolean>("check_workspace", { id: entry.id });
          if (!active()) return;
          setWorkspaceStatus(
            label,
            online === true ? "online" : online === false ? "offline" : "unknown",
          );
        } catch {
          if (!active()) return;
          setWorkspaceStatus(label, "unknown");
        }
      }
    }
    for (let i = 0; i < Math.min(entries.length, 3); i++) void worker();
  }

  async function loadServers(version: number): Promise<Server[]> {
    const owner = account;
    const request = loadWorkspaces(version, owner, true);
    const entries = await transport.invoke<Server[]>("list_servers");
    if (!current(version)) return [];
    renderServers(entries);
    await request;
    return current(version) ? entries : [];
  }

  function renderServers(entries: Server[]) {
    directoryOwner = account;
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
          "selfhost",
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
          "selfhost",
        );
      });
      row.append(open, preferred, remove);
      servers.append(row);
    }
    const name = account?.userinfo.name ?? account?.userinfo.email ?? "Account";
    element("account").textContent = name.trim().charAt(0).toUpperCase() || "A";
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
    directoryPolling = true;
    let timeout: number | undefined;
    try {
      const entries = await Promise.race([
        transport.invoke<Server[]>("list_servers"),
        new Promise<never>((_, reject) => {
          timeout = win?.setTimeout(() => reject(new Error("Server directory timed out")), 4000);
        }),
      ]);
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
      if (directoryOwner !== owner || JSON.stringify(entries) !== directorySnapshot)
        renderServers(entries);
      await loadWorkspaces(version, owner, true);
      if (
        activeScreen === "selfhost" &&
        waitingServerIds &&
        workspaceCatalog &&
        current(version) &&
        screen === "selfhost"
      ) {
        const newServer = workspaceCatalog.organizations
          .find((organization) => organization.id === selectedOrganizationId)
          ?.servers.some((server) => !waitingServerIds!.has(server.id));
        const newWorkspace = workspaceEntries.some(
          (workspace) => !waitingWorkspaceIds?.has(workspace.id),
        );
        if (newServer || newWorkspace) {
          waitingServerIds = null;
          waitingWorkspaceIds = null;
          directoryStage = "servers";
          show("servers");
        }
      }
    } catch {
      // A directory outage does not interrupt the current setup screen.
    } finally {
      win?.clearTimeout(timeout);
      directoryPolling = false;
    }
  }

  const directoryTimer = win.setInterval(() => void refreshWaitingServers(), 15_000);
  const refreshOnReturn = () => void refreshWaitingServers();
  win.addEventListener("focus", refreshOnReturn);
  doc.addEventListener("visibilitychange", refreshOnReturn);
  cleanups.push(() => {
    win.clearInterval(directoryTimer);
    win.removeEventListener("focus", refreshOnReturn);
    doc.removeEventListener("visibilitychange", refreshOnReturn);
  });

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
      if (
        current(version) &&
        (name === "connect_saved_server" || name === "connect_workspace") &&
        typeof args?.id === "string"
      ) {
        failedServer = { id: args.id, local, command: name };
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
      local
        ? "local"
        : name === "connect_saved_server" || name === "connect_workspace"
          ? "servers"
          : "selfhost",
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
          ? {
              id: startup.serverId,
              local: startup.kind === "local",
              command: "connect_saved_server",
            }
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

  async function _createPairing() {
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
    accountEpoch++;
    if (pendingWorkspace) {
      await openPendingWorkspace(version);
      return;
    }
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
      organizationCount === 0
        ? (entries.find((entry) => entry.isDefault) ??
          (entries.length === 1 ? entries[0] : undefined))
        : undefined;
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
    if (screen === "servers" && directoryStage !== "organization") {
      directoryStage = directoryStage === "location" ? "servers" : "organization";
      if (directoryStage === "organization" && !organizationCount) directoryStage = "servers";
      controls();
      return;
    }
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
      const organization = workspaceCatalog?.organizations.find(
        (row) => row.id === selectedOrganizationId,
      );
      command.value = organization
        ? `${SERVER_INSTALL_COMMAND} -s -- --organization ${organization.id} --auto-direct-route`
        : `${SERVER_INSTALL_COMMAND} -s -- --auto-direct-route`;
      waitingServerIds = new Set(
        workspaceCatalog?.organizations
          .find((organization) => organization.id === selectedOrganizationId)
          ?.servers.map((server) => server.id) ?? [],
      );
      waitingWorkspaceIds = new Set(workspaceEntries.map((workspace) => workspace.id));
      show("selfhost");
    }
  });
  on(
    "local",
    "click",
    () =>
      void connect(
        "connect_local_server",
        { organizationId: selectedOrganizationId ?? null },
        true,
      ),
  );
  on(
    "retry-local",
    "click",
    () =>
      void connect(
        "connect_local_server",
        { organizationId: selectedOrganizationId ?? null },
        true,
      ),
  );
  on("retry-server", "click", () => {
    if (failedServer)
      void connect(failedServer.command, { id: failedServer.id }, failedServer.local);
  });
  on("organization-next", "click", () => {
    if (!selectedOrganizationId || operation) return;
    directoryStage = "servers";
    controls();
  });
  on("add-server", "click", () => {
    if (operation) return;
    directoryStage = "location";
    controls();
  });
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
    accountEpoch++;
    pendingWorkspace = null;
    failedServer = null;
    startup = { phase: "idle" };
    renderOrk(welcomeOrk);
    operation = null;
    browserSignIn = false;
    input.value = "";
    element("account").textContent = "";
    element<HTMLDetailsElement>("account-menu").open = false;
    servers.replaceChildren();
    workspaces.replaceChildren();
    organizationCount = null;
    workspaceCatalog = null;
    workspaceEntries = [];
    selectedOrganizationId = undefined;
    directoryStage = "organization";
    waitingServerIds = null;
    waitingWorkspaceIds = null;
    workspaceSnapshot = "";
    workspaceProbeGeneration++;
    element("workspaces-section").hidden = true;
    element("workspaces-error").hidden = true;
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
          const dockerBlocked =
            payload.phase === "docker-missing" || payload.phase === "docker-not-running";
          const index =
            payload.phase === "ready"
              ? phases.length
              : dockerBlocked
                ? 0
                : phases.findIndex((phase) => phase.dataset.phase === payload.phase);
          if (index >= 0)
            for (let i = 0; i < phases.length; i++) {
              const phase = phases[i];
              if (phase) {
                phase.dataset.state =
                  i < index
                    ? "done"
                    : i === index
                      ? dockerBlocked
                        ? "error"
                        : "current"
                      : "pending";
                if (i === index && !dockerBlocked) phase.setAttribute("aria-current", "step");
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
      const stopWorkspaceLinks = await transport.listen<WorkspaceLink>(
        "desktop-workspace-link",
        ({ payload }) => receivePendingWorkspace(payload),
      );
      if (!current(version)) {
        stopWorkspaceLinks();
        return;
      }
      cleanups.push(stopWorkspaceLinks);
      const state = await transport.invoke<{
        startup?: Startup;
        pendingServer?: string;
        pendingWorkspace?: WorkspaceLink;
        initializingServer?: string;
      } | null>("setup_state");
      if (!current(version)) return;
      receivePendingServer({
        origin: state?.pendingServer,
        initialize: state?.initializingServer === state?.pendingServer,
      });
      if (state?.pendingWorkspace) receivePendingWorkspace(state.pendingWorkspace);
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
