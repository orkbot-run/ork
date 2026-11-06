// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { createAvatar } from "@orkbot/avatar";
import { logoAvatarTraits, seededLogoAvatarColor } from "@orkbot/core/logo-avatar-traits";
import { isPersonalOrkId } from "@orkbot/core/personal-ork";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupTransport } from "./setup-view.js";
import { mountSetup } from "./setup-view.js";

const markup = readFileSync(path.join(import.meta.dirname, "../tauri-ui/index.html"), "utf8");
const account = { userinfo: { name: "Test account" } };
const saved = [
  { id: "first-server", kind: "selfhosted", url: "https://one.example.com", isDefault: false },
  { id: "second-server", kind: "selfhosted", url: "https://two.example.com", isDefault: false },
];
const cleanups: (() => void)[] = [];
const pairingOrigin = "https://new.example.com";
const pairingTicket = () => ({
  id: "a".repeat(64),
  code: "2A3B4C",
  expiresAt: Math.floor(Date.now() / 1000) + 60,
});
const installCommand = () => ({
  id: "10000000-0000-4000-8000-000000000001",
  command: "bash install-images.sh --server --code one-time-test-code",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  url: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function node<T extends HTMLElement = HTMLButtonElement>(id: string): T {
  return document.getElementById(id) as T;
}
function screen() {
  return document.querySelector<HTMLElement>(".shell")?.dataset.screen;
}
async function setup(
  options: {
    session?: unknown;
    startup?: unknown;
    pendingServer?: string;
    initializingServer?: string;
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  } = {},
) {
  document.open();
  document.write(markup);
  document.close();
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const stops = new Map<string, ReturnType<typeof vi.fn>>();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "setup_state")
      return {
        startup: options.startup ?? { phase: "idle" },
        pendingServer: options.pendingServer,
        initializingServer: options.initializingServer,
      };
    if (options.invoke) return options.invoke(command, args);
    if (command === "setup_accounts_session") return options.session ?? null;
    if (command === "list_servers") return saved;
    if (command === "setup_accounts_sign_in") return account;
    if (command === "create_server_installation") return installCommand();
    if (command === "create_server_pairing") return pairingTicket();
    if (command === "server_initialization_required") return true;
    return undefined;
  });
  const transport: SetupTransport = {
    invoke: invoke as SetupTransport["invoke"],
    listen: async (event, callback) => {
      listeners.set(event, callback as (event: { payload: unknown }) => void);
      const stop = vi.fn(() => listeners.delete(event));
      stops.set(event, stop);
      return stop;
    },
  };
  const dispose = mountSetup(document, transport);
  cleanups.push(dispose);
  await flush();
  return {
    invoke,
    dispose,
    stops,
    emit: (phase: string, output: string[] = []) =>
      listeners.get("desktop-stack-changed")?.({ payload: { phase, message: null, output } }),
    startup: (value: unknown) => listeners.get("desktop-startup-changed")?.({ payload: value }),
    link: (value: unknown) => listeners.get("desktop-server-link")?.({ payload: value }),
  };
}

async function openInstaller() {
  node("selfhost").click();
  await flush();
  node<HTMLDetailsElement>("install").open = true;
  node("install").dispatchEvent(new Event("toggle"));
  await flush();
}

async function continueSetup(options: Parameters<typeof setup>[0] = {}) {
  const fixture = await setup(options);
  node("get-started").click();
  await flush();
  return fixture;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bundled desktop setup", () => {
  it("reveals welcome without requesting stored credentials until the user continues", async () => {
    const check = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return check.promise;
        if (name === "list_servers") return saved;
        return undefined;
      },
    });
    expect(screen()).toBe("welcome");
    expect(node("get-started").disabled).toBe(false);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["setup_state"]);
    node("get-started").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("setup_accounts_session");
    expect(node("browser-hint").hidden).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("setup_accounts_sign_in", expect.anything());
    check.resolve(account);
    await flush();
    expect(screen()).toBe("servers");
    expect(invoke).not.toHaveBeenCalledWith("setup_accounts_sign_in", expect.anything());
  });

  it("ignores stored credentials returned after the user cancels", async () => {
    const check = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => (name === "setup_accounts_session" ? check.promise : null),
    });
    node("get-started").click();
    await flush();
    node("cancel-sign-in").click();
    await flush();
    check.resolve(account);
    await flush();
    expect(screen()).toBe("welcome");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("list_servers");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("setup_accounts_sign_in");
  });

  it("opens browser sign-in directly from the localized welcome", async () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("pl-PL");
    const signingIn = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => (name === "setup_accounts_sign_in" ? signingIn.promise : null),
    });
    expect(document.documentElement.lang).toBe("pl");
    expect(node("get-started").textContent).toBe("Zaczynamy");
    expect(screen()).toBe("welcome");
    node("get-started").click();
    await flush();
    expect(invoke.mock.calls.filter(([name]) => name === "setup_accounts_sign_in")).toHaveLength(1);
    expect(screen()).toBe("accounts");
    expect(node("browser-hint").hidden).toBe(false);
    expect(node("sign-in").hidden).toBe(true);
    expect(document.body.textContent).not.toContain("Rozgość się");
    expect(invoke).not.toHaveBeenCalledWith("list_servers", undefined);
  });

  it("loads a verified account's picker only when native startup is idle", async () => {
    const { invoke } = await continueSetup({ session: account });
    expect(screen()).toBe("servers");
    expect(node("servers").textContent).toContain(saved[0]!.url);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "setup_state",
      "setup_accounts_session",
      "list_servers",
    ]);
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it("retains a cold-start server link through Accounts sign-in without opening a saved default", async () => {
    const { invoke } = await setup({ pendingServer: "https://new.example.com" });
    expect(screen()).toBe("welcome");
    node("get-started").click();
    await flush();
    expect(screen()).toBe("selfhost");
    expect(node<HTMLInputElement>("server-url").value).toBe("https://new.example.com");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("connect_server");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("connect_saved_server");
    node("setup").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("create_server_pairing", {
      requestId: expect.any(String),
    });
    expect(node<HTMLInputElement>("pairing-code").value).toBe("2A3B4C");
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
  });

  it("opens the exact saved server from a cold handoff after the user starts Accounts", async () => {
    const { invoke } = await setup({ pendingServer: saved[1]!.url });
    expect(invoke).not.toHaveBeenCalledWith("list_servers", undefined);
    expect(invoke).not.toHaveBeenCalledWith("setup_accounts_session", undefined);
    node("get-started").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("list_servers");
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
  });

  it("opens a warm handoff's exact bookmark instead of generating another pairing key", async () => {
    const { invoke, link } = await continueSetup({ session: account });
    link(saved[1]!.url);
    await flush();
    expect(invoke.mock.calls.filter(([name]) => name === "list_servers")).toHaveLength(3);
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("server_initialization_required", expect.anything());
  });

  it.each([true, false])(
    "routes an unlisted origin using its authoritative initialization state: %s",
    async (required) => {
      const { invoke, link } = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return saved;
          if (name === "server_initialization_required") return required;
          if (name === "create_server_pairing") return pairingTicket();
          return undefined;
        },
      });
      link(pairingOrigin);
      await flush();
      expect(invoke).toHaveBeenCalledWith("server_initialization_required", {
        rawUrl: pairingOrigin,
      });
      if (required) {
        expect(invoke).toHaveBeenCalledWith("create_server_pairing", {
          requestId: expect.any(String),
        });
        expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
      } else {
        expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: pairingOrigin });
        expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
      }
    },
  );

  it("keeps a foreign initialized server behind ordinary login rejection without reinitializing it", async () => {
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "server_initialization_required") return false;
        if (name === "connect_server") throw "Could not continue";
        return undefined;
      },
    });
    link(pairingOrigin);
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: pairingOrigin });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(node("status").textContent).toBe("Could not continue");
    expect(node("pairing").hidden).toBe(true);
  });

  it("does not open an old origin when another link arrives during its initialization probe", async () => {
    const oldProbe = deferred<unknown>();
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "server_initialization_required") return oldProbe.promise;
        return undefined;
      },
    });
    link(pairingOrigin);
    await flush();
    link(saved[1]!.url);
    oldProbe.resolve(false);
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("connect_server", { rawUrl: pairingOrigin });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
  });

  it("ignores an old link lookup when a newer target arrives", async () => {
    const oldDirectory = deferred<unknown>();
    let lookups = 0;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return ++lookups === 2 ? oldDirectory.promise : saved;
        return undefined;
      },
    });
    link(saved[0]!.url);
    await flush();
    link(saved[1]!.url);
    oldDirectory.resolve(saved);
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
  });

  it("cannot open an old account's bookmark after logout and a new account starts", async () => {
    const oldDirectory = deferred<unknown>();
    const other = { userinfo: { name: "Another account" } };
    const others = saved.map((entry) => ({
      ...entry,
      id: `other-${entry.id}`,
      url: entry.url.replace(".example.com", ".example.test"),
    }));
    let owner = account;
    let lookups = 0;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return owner;
        if (name === "list_servers")
          return ++lookups === 2 ? oldDirectory.promise : owner === account ? saved : others;
        return undefined;
      },
    });
    link(saved[0]!.url);
    await flush();
    node("sign-out").click();
    await flush();
    owner = other;
    node("get-started").click();
    await flush();
    oldDirectory.resolve(saved);
    await flush();
    expect(node("account").textContent).toBe("Another account");
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    expect(node("servers").textContent).not.toContain(saved[0]!.url);
  });

  it("Back cancels an in-flight saved-server lookup without opening or pairing", async () => {
    const directory = deferred<unknown>();
    let lookups = 0;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return ++lookups === 2 ? directory.promise : saved;
        return undefined;
      },
    });
    link(saved[0]!.url);
    await flush();
    node("back").click();
    await flush();
    directory.resolve(saved);
    await flush();
    expect(screen()).toBe("servers");
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
  });

  it("proposes a warm link for confirmation and discards it on Back", async () => {
    const { invoke, link } = await continueSetup({ session: account });
    link("https://new.example.com");
    expect(screen()).toBe("selfhost");
    expect(node<HTMLInputElement>("server-url").value).toBe("https://new.example.com");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("connect_server");
    node("back").click();
    await flush();
    expect(screen()).toBe("servers");
    expect(invoke).toHaveBeenCalledWith("clear_server_link", { rawUrl: "https://new.example.com" });
  });

  it("ignores malformed link events without changing the picker", async () => {
    const { link } = await continueSetup({ session: account });
    for (const address of [
      "https://user:secret@example.com",
      "http://example.com",
      "https://example.com/path",
      { url: "https://example.com" },
    ]) {
      link(address);
      expect(screen()).toBe("servers");
    }
  });

  it("keeps the picker hidden throughout native automatic startup and displays local download progress", async () => {
    const { invoke, emit, startup } = await continueSetup({
      session: account,
      startup: { phase: "opening", kind: "local", serverId: "local-id" },
    });
    expect(screen()).toBe("local");
    expect(invoke).not.toHaveBeenCalledWith("list_servers", undefined);
    emit("pulling", ["Downloading image"]);
    expect(document.querySelector('[data-phase="pulling"]')?.getAttribute("data-state")).toBe(
      "current",
    );
    expect(node("output").textContent).toBe("Downloading image");
    startup({ phase: "idle" });
    await flush();
    expect(screen()).toBe("servers");
    expect(invoke.mock.calls.filter(([name]) => name === "connect_saved_server")).toHaveLength(0);
  });

  it("shows a failed default once, preserves alternatives and retries only on request", async () => {
    const { invoke, startup } = await continueSetup({
      session: account,
      startup: { phase: "checking" },
    });
    expect(screen()).toBe("checking");
    startup({
      phase: "failed",
      serverId: saved[0]!.id,
      kind: "selfhosted",
      message: "Server unavailable",
    });
    await flush();
    expect(screen()).toBe("servers");
    expect(node("status").textContent).toBe("Server unavailable");
    expect(node("retry-server").hidden).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    node("refresh").click();
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    node("retry-server").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
  });

  it("auto-connects the effective default after fresh sign-in", async () => {
    const connection = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return null;
        if (name === "setup_accounts_sign_in") return account;
        if (name === "list_servers") return [saved[0], { ...saved[1], isDefault: true }];
        if (name === "connect_saved_server") return connection.promise;
        return undefined;
      },
    });
    node("get-started").click();
    await flush();
    expect(screen()).toBe("opening");
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    connection.resolve(undefined);
    await flush();
    expect(screen()).toBe("servers");
  });

  it("auto-connects an only server after sign-in and keeps local phases visible", async () => {
    const connection = deferred<unknown>();
    const { invoke, emit } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return null;
        if (name === "setup_accounts_sign_in") return account;
        if (name === "list_servers") return [{ ...saved[0], kind: "local" }];
        if (name === "connect_saved_server") return connection.promise;
        return undefined;
      },
    });
    node("get-started").click();
    await flush();
    expect(screen()).toBe("local");
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
    emit("pulling", ["Downloaded layer"]);
    expect(node("output").textContent).toBe("Downloaded layer");
    connection.reject("Docker stopped. Try again.");
    await flush();
    expect(screen()).toBe("servers");
    expect(node("retry-server").hidden).toBe(false);
  });

  it("sets and clears an explicit default without connecting", async () => {
    let entries = saved;
    const { invoke } = await continueSetup({
      invoke: async (name, args) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return entries;
        if (name === "set_default_server")
          entries = saved.map((server) => ({ ...server, isDefault: server.id === args?.id }));
        return undefined;
      },
    });
    node("servers").querySelector<HTMLButtonElement>(".server-default")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("set_default_server", { id: saved[0]!.id });
    expect(node("servers").querySelector(".server-default")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    node("servers").querySelector<HTMLButtonElement>(".server-default")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("set_default_server", { id: null });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it("keeps credential checks behind Continue and allows cancellation while they wait", async () => {
    const check = deferred<unknown>();
    await setup({
      invoke: async (name) => (name === "setup_accounts_session" ? check.promise : []),
    });
    expect(screen()).toBe("welcome");
    expect(node("get-started").disabled).toBe(false);
    node("get-started").click();
    await flush();
    expect(screen()).toBe("accounts");
    node("cancel-sign-in").click();
    await flush();
    check.resolve(null);
    await flush();
    expect(screen()).toBe("welcome");
  });

  it("ignores a completed sign-in after cancellation and allows retry", async () => {
    const signIn = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => (name === "setup_accounts_sign_in" ? signIn.promise : null),
    });
    node("get-started").click();
    node("cancel-sign-in").click();
    await flush();
    signIn.resolve(account);
    await flush();
    expect(screen()).toBe("welcome");
    expect(node("sign-out").hidden).toBe(true);
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("list_servers");
  });

  it("shows native local phases and ignores stale events after leaving", async () => {
    const start = deferred<unknown>();
    const { emit } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "connect_local_server") return start.promise;
        return undefined;
      },
    });
    emit("pulling", ["stale"]);
    expect(node("output").textContent).toBe("");
    node("local").click();
    emit("pulling", ["Downloading image"]);
    expect(screen()).toBe("local");
    expect(
      document.querySelector('[data-phase="checking-docker"]')?.getAttribute("data-state"),
    ).toBe("done");
    expect(node("details").hidden).toBe(false);
    start.reject("Docker stopped. Try again.");
    await flush();
    expect(node("retry-local").hidden).toBe(false);
    node("back").click();
    emit("ready", ["stale"]);
    expect(screen()).toBe("servers");
    expect(node("output").textContent).toBe("");
  });

  it("clears a late directory response when signing out", async () => {
    const directory = deferred<unknown>();
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return directory.promise;
        return undefined;
      },
    });
    node("sign-out").click();
    await flush();
    directory.resolve(saved);
    await flush();
    expect(screen()).toBe("welcome");
    expect(node("servers").textContent).toBe("");
    expect(node("account").textContent).toBe("");
  });

  it("generates a key without an address and opens only the explicitly approved domain after ready", async () => {
    vi.useFakeTimers();
    const ticket = pairingTicket();
    let approved = false;
    let ready = false;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return {
            status: ready ? "ready" : approved ? "approved" : "approval-required",
            origin: pairingOrigin,
            expiresAt: ticket.expiresAt,
          };
        if (name === "approve_server_pairing") {
          approved = true;
          return { status: "approved", origin: pairingOrigin, expiresAt: ticket.expiresAt };
        }
        if (name === "list_servers")
          return ready
            ? [...saved, { id: "paired-server", url: pairingOrigin, kind: "selfhosted" }]
            : saved;
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("create_server_pairing", { requestId: expect.any(String) });
    expect(node("legacy-target").hidden).toBe(true);
    expect(node<HTMLInputElement>("pairing-code").value).toBe(ticket.code);
    expect(node("pairing-expires").textContent).toContain("Valid until");
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    node("copy-pairing").click();
    await flush();
    expect(document.activeElement?.id).toBe("pairing-code");
    expect(node<HTMLInputElement>("pairing-code").selectionEnd).toBe(6);
    await vi.advanceTimersByTimeAsync(2000);
    expect(node("pairing-origin").textContent).toBe(pairingOrigin);
    expect(node("pairing-approval").hidden).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("approve_server_pairing", expect.anything());
    node("approve-pairing").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("approve_server_pairing", {
      requestId: expect.any(String),
      origin: pairingOrigin,
    });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    ready = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: "paired-server" });
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
    expect(node<HTMLInputElement>("pairing-code").value).toBe("");
  });

  it.each(["approved", "ready"])(
    "refuses remote %s before any explicit local approval",
    async (status) => {
      vi.useFakeTimers();
      const ticket = pairingTicket();
      const { invoke } = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return saved;
          if (name === "create_server_pairing") return ticket;
          if (name === "get_server_pairing")
            return { status, origin: pairingOrigin, expiresAt: ticket.expiresAt };
          return undefined;
        },
      });
      node("selfhost").click();
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("approve_server_pairing", expect.anything());
      expect(node("status").dataset.error).toBe("true");
    },
  );

  it("does not replace the displayed domain when a claim changes", async () => {
    vi.useFakeTimers();
    const ticket = pairingTicket();
    let origin = pairingOrigin;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return { status: "approval-required", origin, expiresAt: ticket.expiresAt };
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    origin = "https://replacement.example.com";
    await vi.advanceTimersByTimeAsync(2000);
    expect(node("pairing-origin").textContent).toBe(pairingOrigin);
    node("approve-pairing").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("approve_server_pairing", {
      requestId: expect.any(String),
      origin: pairingOrigin,
    });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it.each(["back", "sign-out", "cancel-pairing", "dispose"])(
    "ignores an approval response after %s",
    async (action) => {
      vi.useFakeTimers();
      const ticket = pairingTicket();
      const pending = deferred<unknown>();
      const fixture = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return saved;
          if (name === "create_server_pairing") return ticket;
          if (name === "get_server_pairing")
            return {
              status: "approval-required",
              origin: pairingOrigin,
              expiresAt: ticket.expiresAt,
            };
          if (name === "approve_server_pairing") return pending.promise;
          return undefined;
        },
      });
      node("selfhost").click();
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      node("approve-pairing").click();
      await flush();
      if (action === "dispose") fixture.dispose();
      else node(action).click();
      await flush();
      pending.resolve({ status: "approved", origin: pairingOrigin, expiresAt: ticket.expiresAt });
      await flush();
      expect(fixture.invoke).toHaveBeenCalledWith("cancel_server_pairing", {
        requestId: expect.any(String),
      });
      expect(fixture.invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
      expect(node<HTMLInputElement>("pairing-code").value).toBe("");
    },
  );

  it("does not open a completed approval if a new link arrives during directory refresh", async () => {
    vi.useFakeTimers();
    const ticket = pairingTicket();
    const refresh = deferred<unknown>();
    let approved = false;
    let ready = false;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return ready ? refresh.promise : saved;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return {
            status: ready ? "ready" : "approval-required",
            origin: pairingOrigin,
            expiresAt: ticket.expiresAt,
          };
        if (name === "approve_server_pairing") {
          approved = true;
          return { status: "approved", origin: pairingOrigin, expiresAt: ticket.expiresAt };
        }
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    node("approve-pairing").click();
    await flush();
    expect(approved).toBe(true);
    ready = true;
    await vi.advanceTimersByTimeAsync(2000);
    link("https://replacement.example.com");
    refresh.resolve([...saved, { id: "paired-server", kind: "selfhosted", url: pairingOrigin }]);
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    expect(screen()).toBe("selfhost");
  });

  it("cancels an in-flight key on Back and ignores its late result after returning", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing")
          return ++calls === 1 ? pending.promise : { ...pairingTicket(), code: "5D6E7F" };
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    const first = invoke.mock.calls.find(([name]) => name === "create_server_pairing")![1] as {
      requestId: string;
    };
    node("back").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("cancel_server_pairing", { requestId: first.requestId });
    node("selfhost").click();
    await flush();
    pending.resolve(pairingTicket());
    await flush();
    expect(node<HTMLInputElement>("pairing-code").value).toBe("5D6E7F");
  });

  it("expires a key without a target and stops polling", async () => {
    vi.useFakeTimers();
    const ticket = { ...pairingTicket(), expiresAt: Math.floor(Date.now() / 1000) + 3 };
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return { status: "pending", origin: null, expiresAt: ticket.expiresAt };
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(node("pairing").hidden).toBe(true);
    expect(node("status").textContent).toContain("expired");
    expect(invoke.mock.calls.filter(([name]) => name === "get_server_pairing")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it("creates a domain-free installer only when its disclosure is opened", async () => {
    const { invoke } = await continueSetup({ session: account });
    await openInstaller();
    expect(invoke).toHaveBeenCalledWith("create_server_installation");
    const value = node<HTMLTextAreaElement>("install-command").value;
    expect(value).toContain("--server --code");
    expect(value).not.toContain("--url");
    expect(node("installation").hidden).toBe(false);
    node("copy").click();
    await flush();
    expect(document.activeElement?.id).toBe("install-command");
    expect(node<HTMLTextAreaElement>("install-command").selectionEnd).toBe(value.length);
  });

  it("preserves the confirmed legacy initialization link without waiting for installation polling", async () => {
    const connection = deferred<unknown>();
    const { invoke } = await continueSetup({
      pendingServer: "https://new.example.com",
      initializingServer: "https://new.example.com",
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_installation") return installCommand();
        if (name === "connect_server") return connection.promise;
        return undefined;
      },
    });
    await openInstaller();
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node<HTMLFormElement>("setup").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(screen()).toBe("opening");
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: "https://new.example.com" });
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    connection.resolve(undefined);
    await flush();
    expect(screen()).toBe("servers");
  });

  it("discards a command that finishes after back or sign-out", async () => {
    const ticket = deferred<unknown>();
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return ticket.promise;
        return undefined;
      },
    });
    await openInstaller();
    node("back").click();
    ticket.resolve(installCommand());
    await flush();
    expect(screen()).toBe("servers");
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    await openInstaller();
    node("sign-out").click();
    await flush();
    expect(screen()).toBe("welcome");
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
  });

  it("expires unused commands and removes both native listeners on disposal", async () => {
    vi.useFakeTimers();
    const { dispose, stops, invoke } = await continueSetup({ session: account });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(node("installation").hidden).toBe(true);
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    expect(node("create-installation").hidden).toBe(false);
    expect(node("installation-status").textContent).toContain("expired");
    const count = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    expect(invoke.mock.calls).toHaveLength(count);
    dispose();
    for (const stop of stops.values()) expect(stop).toHaveBeenCalledOnce();
  });

  it("shows remote installation progress and connects only after ready", async () => {
    vi.useFakeTimers();
    let phase = "preparing";
    const value = installCommand();
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_installation") return value;
        if (name === "get_server_installation")
          return {
            ...value,
            phase,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            url: "https://new.example.com",
          };
        return undefined;
      },
    });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation").hidden).toBe(true);
    expect(node("installation-status").textContent).toBe("Prepare server");
    phase = "pulling";
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation-status").textContent).toBe("Download Ork");
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
    phase = "ready";
    await vi.advanceTimersByTimeAsync(3000);
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: "https://new.example.com" });
    expect(screen()).toBe("servers");
  });

  it("ignores an installation result arriving after logout", async () => {
    vi.useFakeTimers();
    const progress = deferred<unknown>();
    const ticket = installCommand();
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return ticket;
        if (name === "get_server_installation") return progress.promise;
        return undefined;
      },
    });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(3000);
    node("sign-out").click();
    await flush();
    progress.resolve({ ...ticket, phase: "ready", url: "https://new.example.com" });
    await flush();
    expect(screen()).toBe("welcome");
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
  });

  it("allows retrying a failed installation with the same command and follows its resumed status", async () => {
    vi.useFakeTimers();
    const ticket = installCommand();
    let phase = "preparing";
    const deadline = new Date(Date.now() + 180_000).toISOString();
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return ticket;
        if (name === "get_server_installation")
          return { ...ticket, phase, expiresAt: deadline, url: "https://new.example.com" };
        return undefined;
      },
    });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(63_000);
    phase = "failed";
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation").hidden).toBe(false);
    expect(node<HTMLTextAreaElement>("install-command").value).toBe(ticket.command);
    expect(node("create-installation").hidden).toBe(true);
    node("copy").click();
    await flush();
    expect(node<HTMLTextAreaElement>("install-command").selectionEnd).toBe(ticket.command.length);
    phase = "pulling";
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation").hidden).toBe(true);
    expect(node("installation-status").textContent).toBe("Download Ork");
    expect(
      invoke.mock.calls.filter(([name]) => name === "create_server_installation"),
    ).toHaveLength(1);
  });

  it("stops polling at the reported absolute deadline when Accounts goes offline after pairing", async () => {
    vi.useFakeTimers();
    const ticket = installCommand();
    const deadline = new Date(Date.now() + 12_000).toISOString();
    let online = true;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return ticket;
        if (name === "get_server_installation") {
          if (!online) throw new Error("Offline");
          return { ...ticket, phase: "pulling", expiresAt: deadline };
        }
        return undefined;
      },
    });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation-status").textContent).toBe("Download Ork");
    online = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(node("installation-status").textContent).toContain("expired");
    const requests = invoke.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(invoke.mock.calls).toHaveLength(requests);
  });

  it("keeps polling after a temporary status error and stops on an expired ticket", async () => {
    vi.useFakeTimers();
    let fail = true;
    const ticket = installCommand();
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return ticket;
        if (name === "get_server_installation") {
          if (fail) throw new Error("Offline");
          return { ...ticket, phase: "expired" };
        }
        return undefined;
      },
    });
    await openInstaller();
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation-status").textContent).toContain("Retrying");
    fail = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(node("installation-status").textContent).toContain("expired");
    expect(node("create-installation").hidden).toBe(false);
  });
});

it("carries exactly the visible welcome Ork into sign-up and restores an existing account Ork", async () => {
  const savedSeed = "f4c2f322-7b3b-4a53-a44c-47647614fdc0";
  const { invoke } = await setup({
    invoke: async (name) => {
      if (name === "setup_accounts_sign_in") return { userinfo: { ork_avatar: savedSeed } };
      return name === "list_servers" ? [] : null;
    },
  });
  const visible = node("hero").querySelector("svg")?.id;
  node("get-started").click();
  await flush();
  const args = invoke.mock.calls.find(([name]) => name === "setup_accounts_sign_in")?.[1];
  expect(isPersonalOrkId(args?.orkAvatar)).toBe(true);
  const portrait = (id: string) =>
    createAvatar({
      ...logoAvatarTraits(id, seededLogoAvatarColor(id)).appearance,
      color: seededLogoAvatarColor(id),
      background: "transparent",
      animate: false,
    }).id;
  expect(visible).toBe(portrait(args!.orkAvatar as string));
  expect(node("hero").querySelector("svg")?.id).toBe(portrait(savedSeed));
});

it("ignores malformed avatar metadata and never inserts account HTML into artwork", async () => {
  await continueSetup({ session: { userinfo: { ork_avatar: '<svg onload="attacker()">' } } });
  expect(node("hero").querySelector("svg")).not.toBeNull();
  expect(node("hero").innerHTML).not.toContain("attacker");
  expect(node("hero").querySelector("[onload]")).toBeNull();
});
