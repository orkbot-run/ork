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
      };
    if (options.invoke) return options.invoke(command, args);
    if (command === "setup_accounts_session") return options.session ?? null;
    if (command === "list_servers") return saved;
    if (command === "setup_accounts_sign_in") return account;
    if (command === "create_server_installation") return installCommand();
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
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: "https://new.example.com" });
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

  it("immediately creates a domain-free command and keeps it while entering an existing address", async () => {
    const { invoke } = await continueSetup({ session: account });
    node("selfhost").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("create_server_installation");
    const value = node<HTMLTextAreaElement>("install-command").value;
    expect(value).toContain("--server --code");
    expect(value).not.toContain("--url");
    expect(node("installation").hidden).toBe(false);
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node("server-url").dispatchEvent(new Event("input"));
    expect(node<HTMLTextAreaElement>("install-command").value).toBe(value);
    node("copy").click();
    await flush();
    expect(document.activeElement?.id).toBe("install-command");
    expect(node<HTMLTextAreaElement>("install-command").selectionEnd).toBe(value.length);
  });

  it("connects an entered existing server without waiting for installation polling", async () => {
    const connection = deferred<unknown>();
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_installation") return installCommand();
        if (name === "connect_server") return connection.promise;
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    node("back").click();
    ticket.resolve(installCommand());
    await flush();
    expect(screen()).toBe("servers");
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    node("selfhost").click();
    node("sign-out").click();
    await flush();
    expect(screen()).toBe("welcome");
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
  });

  it("expires unused commands and removes both native listeners on disposal", async () => {
    vi.useFakeTimers();
    const { dispose, stops, invoke } = await continueSetup({ session: account });
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    await flush();
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
    node("selfhost").click();
    await flush();
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
