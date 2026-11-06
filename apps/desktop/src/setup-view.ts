// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createAvatar } from "@orkbot/avatar";
import {
  logoAvatarTraits,
  WELCOME_AVATAR_COLOR,
  WELCOME_AVATAR_IDENTITY,
} from "@orkbot/core/logo-avatar-traits";
import { PL_MESSAGES } from "./locales/pl.js";

type Account = { userinfo: { name?: string; email?: string } };
type Server = { id: string; url: string; kind: "local" | "selfhosted" };
type StackState = { phase: string; message: string | null; output: string[] };
type Installation = { command: string; expiresAt: string; url: string };
type Screen = "checking" | "welcome" | "accounts" | "servers" | "selfhost" | "local" | "opening";
type Operation = "session" | "signin" | "directory" | "install" | "connect" | "local" | "logout";

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
  const install = element<HTMLDetailsElement>("install");
  const steps = [...doc.querySelectorAll<HTMLElement>("[data-step]")];
  const phases = [...doc.querySelectorAll<HTMLElement>("[data-phase]")];
  let account: Account | null = null;
  let screen: Screen = "checking";
  let operation: Operation | null = null;
  let generation = 0;
  let disposed = false;
  let unlisten: (() => void) | undefined;
  let expiryTimer: number | undefined;
  let installation: Installation | null = null;
  const cleanups: (() => void)[] = [];
  const current = (version: number) => !disposed && generation === version;

  for (const node of doc.querySelectorAll<HTMLElement>("[data-copy]")) {
    node.textContent = t(node.dataset.copy ?? "");
  }
  doc.documentElement.lang = win.navigator.language.toLowerCase().startsWith("pl") ? "pl" : "en";
  for (const node of doc.querySelectorAll<HTMLElement>("[aria-label]")) {
    node.setAttribute("aria-label", t(node.getAttribute("aria-label") ?? ""));
  }
  // This markup is produced locally from fixed first-party parameters, never from IPC or input.
  element("hero").innerHTML = createAvatar({
    ...logoAvatarTraits(WELCOME_AVATAR_IDENTITY, WELCOME_AVATAR_COLOR).appearance,
    color: WELCOME_AVATAR_COLOR,
    background: "transparent",
    animate: false,
  }).svg;

  function clearInstallation() {
    win?.clearTimeout(expiryTimer);
    installation = null;
    command.value = "";
    element("installation").hidden = true;
    element("expires").textContent = "";
    element("copy").textContent = t("Copy command");
  }

  function controls() {
    for (const button of doc.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = operation !== null;
    }
    element<HTMLButtonElement>("quit").disabled = false;
    element<HTMLButtonElement>("sign-out").disabled = operation === "logout";
    element<HTMLButtonElement>("cancel-sign-in").disabled = operation === "logout";
    element("sign-out").hidden = !account;
    element("back").hidden = !["accounts", "selfhost", "local"].includes(screen);
    element("browser-hint").hidden = operation !== "signin";
    element("cancel-sign-in").hidden = operation !== "signin";
    element("retry-local").hidden = screen !== "local" || operation !== null;
    input.disabled = operation !== null;
    shell?.setAttribute("aria-busy", String(operation !== null));
  }

  function show(next: Screen, focus = true) {
    if (screen !== next) {
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

  async function run(kind: Operation, action: (version: number) => Promise<void>, failed: Screen) {
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
        operation = null;
        controls();
      }
    }
  }

  async function loadServers(version: number) {
    const entries = await transport.invoke<Server[]>("list_servers");
    if (!current(version)) return;
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
      row.append(open, remove);
      servers.append(row);
    }
    element("account").textContent =
      account?.userinfo.name ?? account?.userinfo.email ?? "Accounts";
  }

  async function connect(name: string, args?: Record<string, unknown>, local = false) {
    if (!account || operation) return;
    await run(
      local ? "local" : "connect",
      async (version) => {
        for (const phase of phases) {
          delete phase.dataset.state;
          phase.removeAttribute("aria-current");
        }
        show(local ? "local" : "opening");
        await transport.invoke(name, args);
        if (!current(version)) return;
        // Native hides setup after activation; leave its next explicit reopening at the picker.
        show("servers", false);
        await loadServers(version);
      },
      local ? "local" : name === "connect_saved_server" ? "servers" : "selfhost",
    );
  }

  const on = (id: string, event: string, listener: EventListener) => {
    const target = element(id);
    target.addEventListener(event, listener);
    cleanups.push(() => target.removeEventListener(event, listener));
  };
  on("get-started", "click", () => show("accounts"));
  on("back", "click", () => {
    if (!operation) {
      generation++;
      show(account ? "servers" : "welcome");
    }
  });
  on("selfhost", "click", () => {
    if (account && !operation) show("selfhost");
  });
  on("local", "click", () => {
    void connect("connect_local_server", undefined, true);
  });
  on("retry-local", "click", () => {
    void connect("connect_local_server", undefined, true);
  });
  on("refresh", "click", () => {
    void run("directory", loadServers, "servers");
  });
  on("setup", "submit", (event) => {
    event.preventDefault();
    if (input.reportValidity()) void connect("connect_server", { rawUrl: input.value });
  });
  on("sign-in", "click", () => {
    void run(
      "signin",
      async (version) => {
        const value = await transport.invoke<Account>("setup_accounts_sign_in");
        if (!current(version)) return;
        account = value;
        show("servers");
        await loadServers(version);
      },
      account ? "servers" : "accounts",
    );
  });
  async function logout() {
    if (operation === "logout" || disposed) return;
    generation++;
    account = null;
    operation = null;
    input.value = "";
    element("account").textContent = "";
    servers.replaceChildren();
    install.open = false;
    clearInstallation();
    show("accounts");
    await run(
      "logout",
      async () => {
        await transport.invoke("setup_accounts_logout");
      },
      "accounts",
    );
  }
  on("sign-out", "click", () => {
    void logout();
  });
  on("cancel-sign-in", "click", () => {
    void logout();
  });
  on("quit", "click", () => {
    clearInstallation();
    void transport.invoke("quit_setup").catch(errorMessage);
  });
  on("server-url", "input", clearInstallation);
  on("install", "toggle", () => {
    if (!install.open) clearInstallation();
  });
  on("create-installation", "click", () => {
    if (!account || !input.reportValidity()) return;
    clearInstallation();
    void run(
      "install",
      async (version) => {
        const value = await transport.invoke<Installation>("create_server_installation", {
          rawUrl: input.value,
        });
        if (!current(version) || !install.open) return;
        const expires = Date.parse(value.expiresAt);
        if (!value.command || !Number.isFinite(expires) || expires <= Date.now()) {
          throw "The install command has expired. Create a new one.";
        }
        installation = value;
        input.value = value.url;
        command.value = value.command;
        element("installation").hidden = false;
        element("expires").textContent =
          `${t("Valid until")} ${new Date(expires).toLocaleTimeString(doc.documentElement.lang, { hour: "2-digit", minute: "2-digit" })}`;
        expiryTimer = win?.setTimeout(
          clearInstallation,
          Math.min(expires - Date.now(), 2_147_483_647),
        );
      },
      "selfhost",
    );
  });
  on("copy", "click", () => {
    const value = installation;
    if (!value || Date.parse(value.expiresAt) <= Date.now()) {
      clearInstallation();
      return;
    }
    const version = generation;
    const text = command.value;
    void Promise.resolve()
      .then(() => {
        if (!current(version) || installation !== value) return;
        return win?.navigator.clipboard?.writeText(text) ?? Promise.reject();
      })
      .then(() => {
        if (current(version) && installation === value) element("copy").textContent = t("Copied");
      })
      .catch(() => {
        if (!current(version) || installation !== value) return;
        command.focus();
        command.select();
        status.textContent = t("Select and copy the command.");
      });
  });

  show("checking", false);
  void run(
    "session",
    async (version) => {
      const stop = await transport.listen<StackState>("desktop-stack-changed", ({ payload }) => {
        if (disposed || !account || operation !== "local" || screen !== "local") return;
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
      });
      if (!current(version)) {
        stop();
        return;
      }
      unlisten = stop;
      const value = await transport.invoke<Account | null>("setup_accounts_session");
      if (!current(version)) return;
      account = value;
      show(value ? "servers" : "welcome", false);
      if (value) await loadServers(version);
    },
    "welcome",
  );

  return () => {
    if (disposed) return;
    disposed = true;
    generation++;
    clearInstallation();
    unlisten?.();
    for (const cleanup of cleanups) cleanup();
    servers.replaceChildren();
  };
}
