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
function catalogFixture(workspaces: { id: string; name: string; url: string }[]) {
  return {
    version: 2,
    defaultOrganizationId: null,
    organizations: workspaces.length
      ? [
          {
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "Organization",
            type: "shared",
            role: "member",
            servers: workspaces.map((workspace) => ({
              id: workspace.id,
              name: "Server",
              state: "ready",
              bindingVersion: 1,
              keyFingerprint: "a".repeat(64),
              routes: [
                { id: workspace.id, kind: "direct", address: workspace.url, deviceId: null },
              ],
              workspaces: [
                {
                  id: workspace.id,
                  name: workspace.name,
                  state: "ready",
                  canOpen: true,
                  role: "member",
                },
              ],
            })),
          },
        ]
      : [],
  };
}

async function setup(
  options: {
    session?: unknown;
    startup?: unknown;
    pendingServer?: string;
    pendingWorkspace?: unknown;
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
        pendingWorkspace: options.pendingWorkspace,
        initializingServer: options.initializingServer,
      };
    if (options.invoke) {
      const result = await options.invoke(command, args);
      if (command === "workspace_catalog")
        return Array.isArray(result) ? catalogFixture(result) : (result ?? catalogFixture([]));
      if (result !== undefined || command !== "server_initialization_required") return result;
      return true;
    }
    if (command === "setup_accounts_session") return options.session ?? null;
    if (command === "workspace_catalog") return catalogFixture([]);
    if (command === "list_servers") return saved;
    if (command === "setup_accounts_sign_in") return account;
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
    workspaceLink: (value: unknown) =>
      listeners.get("desktop-workspace-link")?.({ payload: value }),
    changeServer: () => listeners.get("desktop-change-server")?.({ payload: null }),
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

// These cases exercise temporarily disabled personal account pairing.
const xit = it.skip;

describe("bundled desktop setup", () => {
  it.each(["back", "menu"])(
    "cancels local setup and returns to server selection through %s",
    async (action) => {
      const start = deferred<unknown>();
      const fixture = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return [];
          if (name === "connect_local_server") return start.promise;
          return undefined;
        },
      });
      node("local").click();
      await flush();
      expect(screen()).toBe("local");
      expect(node("back").disabled).toBe(false);
      if (action === "back") node("back").click();
      else fixture.changeServer();
      await flush();
      expect(fixture.invoke).toHaveBeenCalledWith("cancel_setup_connection");
      expect(screen()).toBe("servers");
      start.reject("cancelled");
      await flush();
      expect(screen()).toBe("servers");
      expect(node("status").textContent).not.toContain("cancelled");
    },
  );
  it("restores a stored session on startup without opening browser sign-in", async () => {
    const check = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return check.promise;
        if (name === "list_servers") return saved;
        return undefined;
      },
    });
    expect(screen()).toBe("checking");
    expect(node("get-started").disabled).toBe(true);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "setup_state",
      "setup_accounts_session",
    ]);
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
      "workspace_catalog",
      "list_servers",
    ]);
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it("opens the default server after restoring login without requiring a click", async () => {
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [saved[0], { ...saved[1], isDefault: true }];
        return undefined;
      },
    });
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke.mock.calls.filter(([name]) => name === "connect_saved_server")).toHaveLength(1);
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("setup_accounts_sign_in");
  });

  it("offers company workspaces beside local and self-hosted choices and opens the selected workspace", async () => {
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [{ ...saved[0], isDefault: true }];
        if (name === "workspace_catalog")
          return [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Studio",
              url: "https://studio.example.com",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Team",
              url: "https://team.example.com",
            },
          ];
        return undefined;
      },
    });
    expect(screen()).toBe("servers");
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
    expect(node("workspaces-section").hidden).toBe(false);
    expect(node("workspaces").textContent).toContain("Studio");
    expect(node("workspaces").textContent).toContain("Organization");
    expect(node("local").hidden).toBe(false);
    expect(node("selfhost").hidden).toBe(false);
    node("workspaces").querySelector<HTMLButtonElement>(".workspace-choice")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_workspace", {
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("shows wizard stages and detects a server added during self-hosted setup", async () => {
    vi.useFakeTimers();
    let entries = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Studio",
        url: "https://studio.example.com",
      },
    ];
    await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "workspace_catalog") return entries;
        return undefined;
      },
    });
    expect(document.querySelector<HTMLElement>(".shell")?.dataset.directoryStage).toBe(
      "organization",
    );
    node("organization-next").click();
    expect(document.querySelector<HTMLElement>(".shell")?.dataset.directoryStage).toBe("servers");
    node("add-server").click();
    expect(document.querySelector<HTMLElement>(".shell")?.dataset.directoryStage).toBe("location");
    node("selfhost").click();
    expect(screen()).toBe("selfhost");
    entries = [
      ...entries,
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "New workspace",
        url: "https://new.example.com",
      },
    ];
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(screen()).toBe("servers");
    expect(document.querySelector<HTMLElement>(".shell")?.dataset.directoryStage).toBe("servers");
    expect(node("workspaces").textContent).toContain("New workspace");
  });

  it("discards a personal server link and presents the available workspaces", async () => {
    const { invoke } = await setup({
      pendingServer: pairingOrigin,
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "workspace_catalog")
          return [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Studio",
              url: "https://studio.example.com",
            },
          ];
        return undefined;
      },
    });
    expect(screen()).toBe("servers");
    expect(node("workspaces").textContent).toContain("Studio");
    expect(invoke).toHaveBeenCalledWith("clear_server_link", { rawUrl: pairingOrigin });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
  });

  it("does not start personal pairing when a link arrives while signed in", async () => {
    const { invoke, link } = await continueSetup({ session: account });
    link(pairingOrigin);
    await flush();
    expect(screen()).toBe("servers");
    expect(invoke).toHaveBeenCalledWith("clear_server_link", { rawUrl: pairingOrigin });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
  });

  it("shows saved servers in the server selection step", async () => {
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [saved[0]];
        if (name === "workspace_catalog")
          return [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Studio",
              url: "https://studio.example.com",
            },
          ];
        return undefined;
      },
    });
    expect(node("organization-next").hidden).toBe(false);
    node("organization-next").click();
    expect(node("saved-servers").hidden).toBe(false);
    expect(node("servers").textContent).toContain(saved[0]!.url);
    node("servers").querySelector<HTMLButtonElement>(".server-open")!.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
  });

  it("refreshes an unreachable workspace status automatically", async () => {
    vi.useFakeTimers();
    let online = false;
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "workspace_catalog")
          return [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Studio",
              url: "https://studio.example.com",
            },
          ];
        if (name === "check_workspace") return online;
        return undefined;
      },
    });
    expect(node("workspaces-section").hidden).toBe(false);
    expect(node("workspaces").textContent).toContain("Offline");
    expect(node("workspaces").textContent).toContain("Studio");
    online = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await flush();
    expect(node("workspaces").textContent).toContain("Online");
    expect(invoke).toHaveBeenCalledWith("check_workspace", {
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("keeps the picker available and reports a workspace directory failure", async () => {
    await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [saved[0]];
        if (name === "workspace_catalog") throw new Error("unavailable");
        return undefined;
      },
    });
    expect(screen()).toBe("servers");
    expect(node("workspaces-error").hidden).toBe(false);
    expect(node("local").hidden).toBe(false);
    expect(node("selfhost").hidden).toBe(false);
  });

  it.each(["local", "selfhosted"])("opens a sole %s server after restoring login", async (kind) => {
    const connection = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [{ ...saved[0], kind }];
        if (name === "connect_saved_server") return connection.promise;
        return undefined;
      },
    });
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
    expect(screen()).toBe(kind === "local" ? "local" : "opening");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("setup_accounts_sign_in");
    connection.resolve(undefined);
    await flush();
  });

  xit("prioritizes a cold server link over the restored account's default", async () => {
    const { invoke } = await setup({
      pendingServer: saved[1]!.url,
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [{ ...saved[0], isDefault: true }, saved[1]];
        return undefined;
      },
    });
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", { id: saved[0]!.id });
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("setup_accounts_sign_in");
  });

  it("discards a restored session returned after its setup document was disposed", async () => {
    const session = deferred<unknown>();
    const { invoke, dispose } = await setup({
      invoke: async (name) => (name === "setup_accounts_session" ? session.promise : []),
    });
    dispose();
    session.resolve(account);
    await flush();
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("list_servers");
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("connect_saved_server");
  });

  xit("retains a cold-start server link through Accounts sign-in without opening a saved default", async () => {
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

  xit("opens the exact saved server from a cold handoff after the user starts Accounts", async () => {
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

  xit("opens a warm handoff's exact bookmark instead of generating another pairing key", async () => {
    const { invoke, link } = await continueSetup({ session: account });
    link(saved[1]!.url);
    await flush();
    expect(invoke.mock.calls.filter(([name]) => name === "list_servers")).toHaveLength(3);
    expect(invoke).toHaveBeenCalledWith("connect_saved_server", { id: saved[1]!.id });
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("server_initialization_required", expect.anything());
  });

  xit.each([true, false])(
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

  xit("keeps a foreign initialized server behind ordinary login rejection without reinitializing it", async () => {
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

  xit("does not open an old origin when another link arrives during its initialization probe", async () => {
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

  xit("ignores an old link lookup when a newer target arrives", async () => {
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

  xit("cannot open an old account's bookmark after logout and a new account starts", async () => {
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

  xit("proposes a warm link for confirmation and discards it on Back", async () => {
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

  it("shows welcome without interactive sign-in when there is no saved session", async () => {
    const check = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => (name === "setup_accounts_session" ? check.promise : []),
    });
    expect(screen()).toBe("checking");
    check.resolve(null);
    await flush();
    expect(screen()).toBe("welcome");
    expect(node("get-started").disabled).toBe(false);
    expect(invoke.mock.calls.map(([name]) => name)).not.toContain("setup_accounts_sign_in");
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

  it("marks the Docker check as failed and keeps retry in the navigation footer", async () => {
    const start = deferred<unknown>();
    const { emit } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "connect_local_server") return start.promise;
        return undefined;
      },
    });
    node("local").click();
    emit("checking-docker");
    emit("docker-missing");
    expect(
      document.querySelector('[data-phase="checking-docker"]')?.getAttribute("data-state"),
    ).toBe("error");
    expect(
      document.querySelector('[data-phase="checking-docker"]')?.hasAttribute("aria-current"),
    ).toBe(false);
    start.reject(
      "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.",
    );
    await flush();
    expect(node("retry-local").hidden).toBe(false);
    expect(node("retry-local").closest("footer")).not.toBeNull();
    expect(node("status").dataset.error).toBe("true");
  });
  it("passes the selected organization to the native installer and its retry", async () => {
    const catalog = catalogFixture([
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: "Research",
        url: "https://server.example.test",
      },
    ]);
    const organizationId = catalog.organizations[0]!.id;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return catalog;
        if (name === "list_servers") return [];
        if (name === "connect_local_server") throw "Docker stopped. Try again.";
        return undefined;
      },
    });
    node("local").click();
    await flush();
    node("retry-local").click();
    await flush();
    const calls = invoke.mock.calls.filter(([command]) => command === "connect_local_server");
    expect(calls).toEqual([
      ["connect_local_server", { organizationId }],
      ["connect_local_server", { organizationId }],
    ]);
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

  xit("generates a key without an address and opens only the explicitly approved domain after ready", async () => {
    vi.useFakeTimers();
    const ticket = pairingTicket();
    let approved = false;
    let ready = false;
    const { invoke, link } = await continueSetup({
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
    link(pairingOrigin);
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

  xit.each(["approved", "ready"])(
    "refuses remote %s before any explicit local approval",
    async (status) => {
      vi.useFakeTimers();
      const ticket = pairingTicket();
      const { invoke, link } = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return saved;
          if (name === "create_server_pairing") return ticket;
          if (name === "get_server_pairing")
            return { status, origin: pairingOrigin, expiresAt: ticket.expiresAt };
          return undefined;
        },
      });
      link(pairingOrigin);
      await flush();
      await vi.advanceTimersByTimeAsync(2000);
      expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
      expect(invoke).not.toHaveBeenCalledWith("approve_server_pairing", expect.anything());
      expect(node("status").dataset.error).toBe("true");
    },
  );

  xit("does not replace the displayed domain when a claim changes", async () => {
    vi.useFakeTimers();
    const ticket = pairingTicket();
    let origin = pairingOrigin;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return { status: "approval-required", origin, expiresAt: ticket.expiresAt };
        return undefined;
      },
    });
    link(pairingOrigin);
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

  xit.each(["back", "sign-out", "cancel-pairing", "dispose"])(
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
      fixture.link(pairingOrigin);
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

  xit("does not open a completed approval if a new link arrives during directory refresh", async () => {
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
    link(pairingOrigin);
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

  xit("cancels an in-flight key on Back and ignores its late result after returning", async () => {
    const pending = deferred<unknown>();
    let calls = 0;
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing")
          return ++calls === 1 ? pending.promise : { ...pairingTicket(), code: "5D6E7F" };
        return undefined;
      },
    });
    link(pairingOrigin);
    await flush();
    const first = invoke.mock.calls.find(([name]) => name === "create_server_pairing")![1] as {
      requestId: string;
    };
    node("back").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("cancel_server_pairing", { requestId: first.requestId });
    link(pairingOrigin);
    await flush();
    pending.resolve(pairingTicket());
    await flush();
    expect(node<HTMLInputElement>("pairing-code").value).toBe("5D6E7F");
  });

  xit("expires a key without a target and stops polling", async () => {
    vi.useFakeTimers();
    const ticket = { ...pairingTicket(), expiresAt: Math.floor(Date.now() / 1000) + 3 };
    const { invoke, link } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "create_server_pairing") return ticket;
        if (name === "get_server_pairing")
          return { status: "pending", origin: null, expiresAt: ticket.expiresAt };
        return undefined;
      },
    });
    link(pairingOrigin);
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(node("pairing").hidden).toBe(true);
    expect(node("status").textContent).toContain("expired");
    expect(invoke.mock.calls.filter(([name]) => name === "get_server_pairing")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });

  it("shows a self-host command without creating an installation or pairing code", async () => {
    const { invoke } = await continueSetup({ session: account });
    node("selfhost").click();
    await flush();
    const value = node<HTMLTextAreaElement>("install-command").value;
    expect(value).toBe("curl -fsSL https://install.ork.run | sudo -H sh -s -- --auto-direct-route");
    expect(node("installation").hidden).toBe(false);
    expect(node("setup").hidden).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("create_server_installation");
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    node("copy").click();
    await flush();
    expect(document.activeElement?.id).toBe("install-command");
    expect(node<HTMLTextAreaElement>("install-command").selectionEnd).toBe(value.length);
  });

  it("includes the selected organization in the self-host installer command", async () => {
    const workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Workspace",
      url: "https://server.example.com",
    };
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return catalogFixture([workspace]);
        if (name === "list_servers") return saved;
        return undefined;
      },
    });
    node("selfhost").click();
    expect(node<HTMLTextAreaElement>("install-command").value).toBe(
      "curl -fsSL https://install.ork.run | sudo -H sh -s -- --organization aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa --auto-direct-route",
    );
  });

  it("shows a newly authorized server while waiting on the install instructions", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let entries = saved;
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return entries;
        return undefined;
      },
    });
    node("selfhost").click();
    await flush();
    entries = [
      ...saved,
      { id: "new-server", kind: "selfhosted", url: "https://new.example.com", isDefault: false },
    ];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(screen()).toBe("selfhost");
    expect(node("servers").textContent).toContain("https://new.example.com");
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", { id: "new-server" });
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
  });

  it.each(["focus", "visibilitychange"])(
    "refreshes the workspace catalog on %s and opens the server list",
    async (event) => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      const newWorkspace = {
        id: "11111111-1111-4111-8111-111111111111",
        name: "New workspace",
        url: "https://new.example.com",
      };
      const catalog = catalogFixture([newWorkspace]);
      let currentCatalog: typeof catalog = {
        ...catalog,
        organizations: catalog.organizations.map((organization) => ({
          ...organization,
          servers: [],
        })),
      };
      const { invoke, dispose } = await continueSetup({
        invoke: async (name) => {
          if (name === "setup_accounts_session") return account;
          if (name === "list_servers") return saved;
          if (name === "workspace_catalog") return currentCatalog;
          return undefined;
        },
      });
      node("selfhost").click();
      expect(screen()).toBe("selfhost");
      currentCatalog = catalog;
      (event === "focus" ? window : document).dispatchEvent(new Event(event));
      await flush();
      expect(screen()).toBe("servers");
      expect(node("workspaces").textContent).toContain("New workspace");
      const calls = invoke.mock.calls.length;
      dispose();
      (event === "focus" ? window : document).dispatchEvent(new Event(event));
      await flush();
      expect(invoke).toHaveBeenCalledTimes(calls);
    },
  );

  it("shows an existing pending server when its workspace becomes available", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const workspace = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Workspace",
      url: "https://server.example.com",
    };
    const ready = catalogFixture([workspace]);
    let catalog: typeof ready = {
      ...ready,
      organizations: ready.organizations.map((organization) => ({
        ...organization,
        servers: organization.servers.map((server) => ({
          ...server,
          state: "pending",
          routes: [],
        })),
      })),
    };
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return catalog;
        if (name === "list_servers") return saved;
        return undefined;
      },
    });
    node("selfhost").click();
    expect(screen()).toBe("selfhost");
    catalog = ready;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(screen()).toBe("servers");
    expect(node("workspaces").textContent).toContain("Workspace");
  });

  it("retries the directory after a stalled saved-server request", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let serverCalls = 0;
    const pending = deferred<typeof saved>();
    const { invoke } = await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return ++serverCalls === 2 ? pending.promise : saved;
        return undefined;
      },
    });
    node("selfhost").click();
    window.dispatchEvent(new Event("focus"));
    await flush();
    await vi.advanceTimersByTimeAsync(4_000);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(invoke.mock.calls.filter(([name]) => name === "list_servers")).toHaveLength(3);
  });

  it("ignores a directory refresh completed after logout", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const pending = deferred<typeof saved>();
    let calls = 0;
    await continueSetup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return ++calls === 1 ? saved : pending.promise;
        return undefined;
      },
    });
    node("selfhost").click();
    await vi.advanceTimersByTimeAsync(15_000);
    node("sign-out").click();
    await flush();
    pending.resolve([
      ...saved,
      { id: "new-server", kind: "selfhosted", url: "https://new.example.com", isDefault: false },
    ]);
    await flush();
    expect(screen()).toBe("welcome");
    expect(node("servers").textContent).not.toContain("new.example.com");
  });

  xit("preserves a pending legacy initialization link", async () => {
    const { invoke } = await setup({
      session: account,
      pendingServer: pairingOrigin,
      initializingServer: pairingOrigin,
    });
    const input = node<HTMLInputElement>("server-url");
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(pairingOrigin);
    input.value = "https://other.example.com";
    node<HTMLFormElement>("setup").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(invoke).not.toHaveBeenCalledWith("create_server_pairing", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("connect_server", expect.anything());
    input.value = pairingOrigin;
    node<HTMLFormElement>("setup").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: pairingOrigin });
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

describe("explicit workspace links", () => {
  const target = {
    organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    serverId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  };
  const directory = catalogFixture([
    { id: target.workspaceId, name: "Research", url: "https://server.example.test" },
  ]);
  it("opens an available exact target after account restoration", async () => {
    const { invoke } = await setup({
      pendingWorkspace: target,
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return directory;
        if (name === "list_servers") return saved;
      },
    });
    expect(invoke).toHaveBeenCalledWith("connect_workspace", {
      id: target.workspaceId,
      link: target,
    });
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });
  it("refuses an unavailable target without opening a different workspace or server", async () => {
    const { invoke } = await setup({
      pendingWorkspace: { ...target, workspaceId: "22222222-2222-4222-8222-222222222222" },
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return directory;
        if (name === "list_servers") return saved.map((row) => ({ ...row, isDefault: true }));
      },
    });
    expect(node("status").textContent).toContain("Workspace unavailable");
    expect(invoke).not.toHaveBeenCalledWith("connect_workspace", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("connect_saved_server", expect.anything());
  });
  it("discards a link directory result that arrives after logout", async () => {
    const waiting = deferred<unknown>();
    const { invoke } = await setup({
      pendingWorkspace: target,
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "workspace_catalog") return waiting.promise;
        if (name === "list_servers") return saved;
      },
    });
    node("sign-out").click();
    await flush();
    waiting.resolve(directory);
    await flush();
    expect(screen()).toBe("welcome");
    expect(invoke).not.toHaveBeenCalledWith("connect_workspace", expect.anything());
  });
});

it("keeps the workspace chooser usable after saving an organization preference fails", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const { invoke } = await setup({
    invoke: async (name) => {
      if (name === "setup_accounts_session") return account;
      if (name === "list_servers") return [];
      if (name === "workspace_catalog")
        return catalogFixture([{ id, name: "Research", url: "https://server.example.test" }]);
      if (name === "set_default_organization") throw new Error("unavailable");
    },
  });
  node("workspaces").querySelector<HTMLButtonElement>(".link")!.click();
  await flush();
  expect(node("status").dataset.error).toBe("true");
  node("workspaces").querySelector<HTMLButtonElement>(".workspace-choice")!.click();
  await flush();
  expect(invoke).toHaveBeenCalledWith("connect_workspace", { id });
});
