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
const saved = [{ id: "saved-server", kind: "selfhosted", url: "https://ork.example.com" }];
const cleanups: (() => void)[] = [];

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
  for (let i = 0; i < 8; i++) await Promise.resolve();
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
    invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  } = {},
) {
  document.open();
  document.write(markup);
  document.close();
  let stackEvent:
    | ((event: { payload: { phase: string; message: string | null; output: string[] } }) => void)
    | undefined;
  const stop = vi.fn();
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (options.invoke) return options.invoke(command, args);
    if (command === "setup_accounts_session") return options.session ?? null;
    if (command === "list_servers") return saved;
    if (command === "setup_accounts_sign_in") return account;
    return undefined;
  });
  const transport: SetupTransport = {
    invoke: invoke as SetupTransport["invoke"],
    listen: async (_event, callback) => {
      stackEvent = callback as typeof stackEvent;
      return stop;
    },
  };
  const dispose = mountSetup(document, transport);
  cleanups.push(dispose);
  await flush();
  return {
    invoke,
    dispose,
    stop,
    emit: (phase: string, output: string[] = []) =>
      stackEvent?.({ payload: { phase, message: null, output } }),
  };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bundled desktop setup", () => {
  it("uses the existing Polish catalog for the visible welcome and actions", async () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("pl-PL");
    await setup();
    expect(document.documentElement.lang).toBe("pl");
    expect(document.querySelector('[data-step="welcome"] h1')?.textContent).toBe("Witaj w Ork");
    expect(node("get-started").textContent).toBe("Zaczynajmy");
    node("get-started").click();
    expect(node("sign-in").textContent).toBe("Kontynuuj z Accounts");
  });

  it("progresses from welcome to browser sign-in and only then loads the server directory", async () => {
    const { invoke } = await setup();
    expect(screen()).toBe("welcome");
    expect(invoke).not.toHaveBeenCalledWith("list_servers", undefined);
    expect(node("hero").querySelector("svg")).not.toBeNull();
    expect(node("hero").querySelector("style")).toBeNull();
    node("get-started").click();
    expect(screen()).toBe("accounts");
    node("sign-in").click();
    expect(node("browser-hint").hidden).toBe(false);
    await flush();
    expect(screen()).toBe("servers");
    expect(node("account").textContent).toBe("Test account");
    expect(node("servers").textContent).toContain(saved[0]?.url);
  });

  it("skips welcome for a verified session without starting Docker or connecting", async () => {
    const { invoke } = await setup({ session: account });
    expect(screen()).toBe("servers");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "setup_accounts_session",
      "list_servers",
    ]);
  });

  it("does not present welcome until the initial session check finishes", async () => {
    const check = deferred<unknown>();
    await setup({
      invoke: (command) =>
        command === "setup_accounts_session" ? check.promise : Promise.resolve([]),
    });
    expect(screen()).toBe("checking");
    expect(node("get-started").disabled).toBe(true);
    check.resolve(null);
    await flush();
    expect(screen()).toBe("welcome");
  });

  it("ignores a completed sign-in after cancellation", async () => {
    const signIn = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (command) => {
        if (command === "setup_accounts_sign_in") return signIn.promise;
        return null;
      },
    });
    node("get-started").click();
    node("sign-in").click();
    node("cancel-sign-in").click();
    await flush();
    signIn.resolve(account);
    await flush();
    expect(screen()).toBe("accounts");
    expect(node("sign-out").hidden).toBe(true);
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain("list_servers");
  });

  it("shows real local phases and ignores stack events outside a local operation", async () => {
    const start = deferred<unknown>();
    const { emit } = await setup({
      invoke: async (command) => {
        if (command === "setup_accounts_session") return account;
        if (command === "list_servers") return [];
        if (command === "connect_local_server") return start.promise;
        return null;
      },
    });
    emit("pulling", ["old output"]);
    expect(node("output").textContent).toBe("");
    node("local").click();
    expect(screen()).toBe("local");
    emit("pulling", ["Downloading image"]);
    expect(
      document.querySelector('[data-phase="checking-docker"]')?.getAttribute("data-state"),
    ).toBe("done");
    expect(document.querySelector('[data-phase="pulling"]')?.getAttribute("data-state")).toBe(
      "current",
    );
    expect(node("details").hidden).toBe(false);
    expect((node("details") as HTMLDetailsElement).open).toBe(false);
    start.reject("Docker stopped. Try again.");
    await flush();
    expect(node("retry-local").hidden).toBe(false);
    expect(node("status").textContent).toBe("Docker stopped. Try again.");
    node("back").click();
    emit("ready", ["stale result"]);
    expect(screen()).toBe("servers");
    expect(node("output").textContent).toBe("");
  });

  it("clears account data on logout while ignoring a late directory response", async () => {
    const directory = deferred<unknown>();
    await setup({
      invoke: async (command) => {
        if (command === "setup_accounts_session") return account;
        if (command === "list_servers") return directory.promise;
        return undefined;
      },
    });
    node("sign-out").click();
    await flush();
    directory.resolve(saved);
    await flush();
    expect(screen()).toBe("accounts");
    expect(node("servers").textContent).toBe("");
    expect(node("account").textContent).toBe("");
    expect(node<HTMLInputElement>("server-url").value).toBe("");
  });

  it("checks the entered server through native IPC and leaves a picker for reopening setup", async () => {
    const connection = deferred<unknown>();
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return saved;
        if (name === "connect_server") return connection.promise;
        return undefined;
      },
    });
    node("selfhost").click();
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node<HTMLFormElement>("setup").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(screen()).toBe("opening");
    expect(invoke).toHaveBeenCalledWith("connect_server", { rawUrl: "https://new.example.com" });
    expect(node("local").disabled).toBe(true);
    connection.resolve(undefined);
    await flush();
    expect(screen()).toBe("servers");
  });

  it("keeps installation codes transient, clears them on address changes, and selects on clipboard denial", async () => {
    const command = "bash install-images.sh --setup-code test-one-use-code";
    const { invoke } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation")
          return {
            command,
            url: "https://new.example.com",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        return undefined;
      },
    });
    node("selfhost").click();
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node<HTMLDetailsElement>("install").open = true;
    node("create-installation").click();
    await flush();
    expect(invoke).toHaveBeenCalledWith("create_server_installation", {
      rawUrl: "https://new.example.com",
    });
    expect(node<HTMLTextAreaElement>("install-command").value).toBe(command);
    node("copy").click();
    await flush();
    expect(document.activeElement?.id).toBe("install-command");
    expect(node<HTMLTextAreaElement>("install-command").selectionEnd).toBe(command.length);
    node("server-url").dispatchEvent(new Event("input"));
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    expect(node("installation").hidden).toBe(true);
  });

  it("drops a late install command when signing out and never restores it", async () => {
    const installation = deferred<unknown>();
    await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation") return installation.promise;
        return undefined;
      },
    });
    node("selfhost").click();
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node<HTMLDetailsElement>("install").open = true;
    node("create-installation").click();
    node("sign-out").click();
    await flush();
    installation.resolve({
      command: "test-code",
      url: "https://new.example.com",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await flush();
    expect(screen()).toBe("accounts");
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
  });

  it("expires displayed commands and removes the native listener on disposal", async () => {
    vi.useFakeTimers();
    const { stop, dispose } = await setup({
      invoke: async (name) => {
        if (name === "setup_accounts_session") return account;
        if (name === "list_servers") return [];
        if (name === "create_server_installation")
          return {
            command: "test-code",
            url: "https://new.example.com",
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
          };
        return undefined;
      },
    });
    node("selfhost").click();
    node<HTMLInputElement>("server-url").value = "https://new.example.com";
    node<HTMLDetailsElement>("install").open = true;
    node("create-installation").click();
    await flush();
    expect(node("installation").hidden).toBe(false);
    vi.advanceTimersByTime(10_001);
    expect(node("installation").hidden).toBe(true);
    expect(node<HTMLTextAreaElement>("install-command").value).toBe("");
    dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
});

it("carries exactly the visible welcome Ork into sign-up and restores an existing account Ork", async () => {
  const savedSeed = "f4c2f322-7b3b-4a53-a44c-47647614fdc0";
  const { invoke } = await setup({
    invoke: async (command) => {
      if (command === "setup_accounts_sign_in") return { userinfo: { ork_avatar: savedSeed } };
      return command === "list_servers" ? [] : null;
    },
  });
  const visible = node("hero").querySelector("svg")?.id;
  node("get-started").click();
  node("sign-in").click();
  await flush();
  const args = invoke.mock.calls.find(([command]) => command === "setup_accounts_sign_in")?.[1];
  expect(isPersonalOrkId(args?.orkAvatar)).toBe(true);
  const seed = args!.orkAvatar as string;
  const portrait = (id: string) =>
    createAvatar({
      ...logoAvatarTraits(id, seededLogoAvatarColor(id)).appearance,
      color: seededLogoAvatarColor(id),
      background: "transparent",
      animate: false,
    }).id;
  expect(visible).toBe(portrait(seed));
  expect(node("hero").querySelector("svg")?.id).toBe(portrait(savedSeed));
});

it("ignores malformed avatar metadata and never inserts account HTML into the welcome artwork", async () => {
  await setup({ session: { userinfo: { ork_avatar: '<svg onload="attacker()">' } } });
  expect(node("hero").querySelector("svg")).not.toBeNull();
  expect(node("hero").innerHTML).not.toContain("attacker");
  expect(node("hero").querySelector("[onload]")).toBeNull();
});
