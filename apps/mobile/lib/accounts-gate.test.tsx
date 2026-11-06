// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { tokensForAppearance } from "@orkbot/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { redirectSystemPath } from "../app/+native-intent";
import { AccountsGate } from "../components/accounts-gate";
import { accountServers, addAccountServer } from "./account-servers";
import { accountsIdentity, continueWithAccounts } from "./accounts";
import { continueWithAccountsServer } from "./accounts-login";
import {
  clearProductAccountSession,
  currentApiBase,
  loadApiBase,
  probeApiBase,
  rpc,
  saveApiBase,
} from "./api";
import type * as Endpoint from "./endpoint";
import { requireAccountsSignIn } from "./endpoint";
import { clearServerConnect, pendingServerConnect, receiveServerConnect } from "./server-connect";
import { currentSessionGeneration } from "./session";
import { continueWithSso } from "./sso";

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  version: 0,
  listeners: new Set<() => void>(),
  appListeners: new Set<(state: string) => void>(),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => state.storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    state.storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    state.storage.delete(key);
  },
}));
vi.mock("expo-splash-screen", () => ({ hideAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../components/logo-avatar", () => ({
  LogoAvatar: ({ identity }: { identity: string }) => <span data-welcome-avatar={identity} />,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (value: string) => void) => {
      state.appListeners.add(listener);
      return { remove: () => state.appListeners.delete(listener) };
    },
  },
  ActivityIndicator: () => <span>Loading</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
    busy: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("light") }));
vi.mock("./appearance", () => ({ loadAppearancePreference: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./i18n", () => ({
  bootstrapI18n: vi.fn().mockResolvedValue(undefined),
  useI18n: () => ({
    t: (value: string, values?: Record<string, string>) =>
      value.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
  t: (value: string) => value,
}));
vi.mock("./user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("./server-headers", () => ({ serverHeaders: () => ({}) }));
vi.mock("./endpoint", async (original) => ({
  ...(await original<typeof Endpoint>()),
  requireAccountsSignIn: vi.fn().mockResolvedValue({ accountsLogin: false }),
}));
vi.mock("./accounts", () => ({
  welcomeAccountsOrk: () => "64cf5621-3144-4810-97f5-148acdc29c35",
  accountsIdentity: vi.fn(),
  continueWithAccounts: vi.fn(),
  signOutAccounts: vi.fn(),
  accountsVersion: () => state.version,
  subscribeAccounts: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock("./account-servers", () => ({ accountServers: vi.fn(), addAccountServer: vi.fn() }));
vi.mock("./incoming-share", () => ({ receiveIncomingShare: vi.fn() }));
vi.mock("./session", () => ({ currentSessionGeneration: vi.fn(() => 1) }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./accounts-login", () => ({ continueWithAccountsServer: vi.fn() }));
vi.mock("./api", () => ({
  currentApiBase: vi.fn(),
  rpc: vi.fn(),
  clearProductAccountSession: vi.fn(),
  loadApiBase: vi.fn(),
  probeApiBase: vi.fn(),
  saveApiBase: vi.fn(),
}));

const identity = { issuer: "https://api.orkbot.run", subject: "subject-a" };
const remote = {
  id: "00000000-0000-4000-8000-000000000001",
  url: "https://server.example.test",
  kind: "selfhosted" as const,
  deviceId: null,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  const linked = pendingServerConnect();
  if (linked) clearServerConnect(linked);
  state.storage.clear();
  state.version = 0;
  state.listeners.clear();
  state.appListeners.clear();
  vi.mocked(accountsIdentity).mockResolvedValue(null);
  vi.mocked(currentSessionGeneration).mockReset().mockReturnValue(1);
  vi.mocked(currentApiBase).mockReturnValue(remote.url);
  vi.mocked(continueWithSso).mockResolvedValue(true);
  vi.mocked(continueWithAccountsServer).mockResolvedValue(true);
  vi.mocked(rpc).mockResolvedValue({ userId: "product-user" } as never);
  vi.mocked(addAccountServer).mockResolvedValue(remote);
  vi.mocked(accountServers).mockResolvedValue([remote]);
  vi.mocked(clearProductAccountSession).mockResolvedValue(undefined);
  vi.mocked(saveApiBase).mockResolvedValue({ ok: true, url: remote.url });
  vi.mocked(probeApiBase).mockResolvedValue({ ok: true, url: remote.url });
  vi.mocked(requireAccountsSignIn).mockResolvedValue({ accountsLogin: false });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <AccountsGate>
        <span>Product screen</span>
      </AccountsGate>,
    ),
  );
}

it("requires Accounts before product screens, directory lookup or product requests", async () => {
  await render();
  expect(host.textContent).toContain("Get started");
  expect(host.textContent).not.toContain("Product screen");
  expect(host.querySelector("input")).toBeNull();
  expect(accountServers).not.toHaveBeenCalled();
  expect(loadApiBase).not.toHaveBeenCalled();
  expect(probeApiBase).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  await act(async () => host.querySelector("button")!.click());
  expect(continueWithAccounts).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Continue with Accounts");
  await act(async () => host.querySelector("button")!.click());
  expect(continueWithAccounts).toHaveBeenCalledTimes(1);
});
it("clears the previous product account and shows only centrally listed servers", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  state.storage.set("orkbot.accounts.product-owner", "different-account");
  await render();
  expect(clearProductAccountSession).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("server.example.test");
  expect(host.textContent).not.toContain("Product screen");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent === "server.example.test")!
      .click(),
  );
  expect(probeApiBase).toHaveBeenCalledWith(remote.url);
  expect(saveApiBase).toHaveBeenCalledWith(remote.url, {});
  expect(host.textContent).toContain("Product screen");
});
it("cannot restore a deleted directory entry from device storage", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  state.storage.set(
    "orkbot.accounts.product-owner",
    JSON.stringify([identity.issuer, identity.subject]),
  );
  state.storage.set(
    "orkbot.accounts.selected-server",
    `${JSON.stringify([identity.issuer, identity.subject])}:deleted`,
  );
  await render();
  expect(host.textContent).not.toContain("Product screen");
  expect(saveApiBase).not.toHaveBeenCalled();
});
it("unmounts product screens when the central session is lost", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  const account = JSON.stringify([identity.issuer, identity.subject]);
  state.storage.set("orkbot.accounts.product-owner", account);
  state.storage.set("orkbot.accounts.selected-server", `${account}:${remote.id}`);
  await render();
  expect(host.textContent).toContain("Product screen");
  vi.mocked(accountsIdentity).mockResolvedValue(null);
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect(host.textContent).not.toContain("Product screen");
  expect(host.textContent).toContain("Get started");
  expect(clearProductAccountSession).toHaveBeenCalledTimes(1);
});

it("stops before mounting any product when the previous account cannot be cleared", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  vi.mocked(clearProductAccountSession).mockRejectedValueOnce(
    new Error("Could not clear previous account"),
  );
  await render();
  expect(host.textContent).not.toContain("Product screen");
  expect(host.textContent).toContain("Could not clear previous account");
  expect(accountServers).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
});

it("cannot adopt an old account after its async cleanup was superseded", async () => {
  let release: () => void = () => undefined;
  vi.mocked(clearProductAccountSession).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  await render();
  expect(clearProductAccountSession).toHaveBeenCalledTimes(1);
  const next = { ...identity, subject: "subject-b" };
  vi.mocked(accountsIdentity).mockResolvedValue(next);
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
    release();
  });
  const owner = JSON.stringify([next.issuer, next.subject]);
  expect(state.storage.get("orkbot.accounts.product-owner")).toBe(owner);
  expect(accountServers).toHaveBeenCalledTimes(1);
  expect(accountServers).toHaveBeenCalledWith(owner);
  expect(host.textContent).not.toContain("Product screen");
});

it("cannot activate an old account's server after a pending endpoint load is superseded", async () => {
  let release: () => void = () => undefined;
  vi.mocked(loadApiBase).mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve(remote.url);
      }),
  );
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  const account = JSON.stringify([identity.issuer, identity.subject]);
  state.storage.set("orkbot.accounts.product-owner", account);
  state.storage.set("orkbot.accounts.selected-server", `${account}:${remote.id}`);
  await render();
  expect(loadApiBase).toHaveBeenCalledTimes(1);
  const next = { ...identity, subject: "subject-b" };
  vi.mocked(accountsIdentity).mockResolvedValue(next);
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
    release();
  });
  expect(saveApiBase).not.toHaveBeenCalled();
  expect(state.storage.get("orkbot.accounts.product-owner")).toBe(
    JSON.stringify([next.issuer, next.subject]),
  );
  expect(state.storage.has("orkbot.accounts.selected-server")).toBe(false);
  expect(host.textContent).not.toContain("Product screen");
});

it("keeps a verified account at server recovery when the directory is unavailable", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  vi.mocked(accountServers).mockRejectedValueOnce(new Error("Directory unavailable"));
  await render();
  expect(host.textContent).toContain("Server");
  expect(host.textContent).toContain("Directory unavailable");
  expect(host.textContent).not.toContain("Continue with Accounts");
  expect(host.textContent).not.toContain("Get started");
  expect(host.textContent).not.toContain("Product screen");
  expect(saveApiBase).not.toHaveBeenCalled();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Retry")!.click(),
  );
  expect(host.textContent).toContain("server.example.test");
  expect(host.querySelector("input")).toBeNull();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  expect(host.querySelector('input[aria-label="Server"]')).not.toBeNull();
});

it("offers other servers after the remembered server fails verification without mounting product", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  const account = JSON.stringify([identity.issuer, identity.subject]);
  state.storage.set("orkbot.accounts.product-owner", account);
  state.storage.set("orkbot.accounts.selected-server", `${account}:${remote.id}`);
  vi.mocked(requireAccountsSignIn).mockRejectedValueOnce(new Error("Server unavailable"));
  await render();
  expect(host.textContent).toContain("server.example.test");
  expect(host.textContent).toContain("Server unavailable");
  expect(host.textContent).not.toContain("Get started");
  expect(host.textContent).not.toContain("Product screen");
  expect(saveApiBase).not.toHaveBeenCalled();
});

it("keeps the welcome Ork through signup and restores the account Ork for an existing user", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(null);
  await render();
  const preview = host.querySelector("[data-welcome-avatar]")?.getAttribute("data-welcome-avatar");
  expect(preview).toBe("64cf5621-3144-4810-97f5-148acdc29c35");
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
  });
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
  });
  expect(continueWithAccounts).toHaveBeenCalledWith(preview);
  const saved = "f4c2f322-7b3b-4a53-a44c-47647614fdc0";
  vi.mocked(accountsIdentity).mockResolvedValue({ ...identity, orkAvatar: saved });
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect(host.querySelector("[data-welcome-avatar]")?.getAttribute("data-welcome-avatar")).toBe(
    saved,
  );
});

it("retains a connection link through Accounts login and requires confirmation before product login", async () => {
  const destination = redirectSystemPath({
    path: `orkbot://connect?server=${encodeURIComponent(remote.url)}`,
    initial: false,
  });
  expect(destination).toBe("/");
  await act(async () =>
    root.render(
      <AccountsGate>
        {destination === "/" ? <span>Product screen</span> : <AccountsGate onSelected={vi.fn()} />}
      </AccountsGate>,
    ),
  );
  expect(addAccountServer).not.toHaveBeenCalled();
  expect(continueWithSso).not.toHaveBeenCalled();
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect((host.querySelector("input") as HTMLInputElement).value).toBe(remote.url);
  expect(host.textContent).not.toContain("Product screen");
  expect(continueWithSso).not.toHaveBeenCalled();
  expect(addAccountServer).not.toHaveBeenCalled();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  expect(continueWithSso).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith("me");
  expect(addAccountServer).toHaveBeenCalledWith(
    remote.url,
    JSON.stringify([identity.issuer, identity.subject]),
  );
  expect(vi.mocked(rpc).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(addAccountServer).mock.invocationCallOrder[0]!,
  );
  expect(pendingServerConnect()).toBeNull();
  expect(host.textContent).toContain("Product screen");
});

it.each(["cancel", "rejected", "session-change"])(
  "never bookmarks an unverified product login (%s)",
  async (outcome) => {
    receiveServerConnect(`orkbot://connect?server=${encodeURIComponent(remote.url)}`);
    vi.mocked(accountsIdentity).mockResolvedValue(identity);
    if (outcome === "cancel") vi.mocked(continueWithSso).mockResolvedValue(false);
    if (outcome === "rejected") vi.mocked(rpc).mockRejectedValue(new Error("Not admitted"));
    if (outcome === "session-change")
      vi.mocked(currentSessionGeneration).mockReturnValueOnce(1).mockReturnValue(2);
    await render();
    await act(async () =>
      [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
    );
    expect(addAccountServer).not.toHaveBeenCalled();
    expect(pendingServerConnect()).toBe(remote.url);
    expect(host.textContent).not.toContain("Product screen");
  },
);

it("uses a native proof to add a server without an OIDC client", async () => {
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(remote.url)}&secret=${"s".repeat(43)}`,
  );
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  vi.mocked(requireAccountsSignIn).mockResolvedValue({ accountsLogin: true });
  await render();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  expect(continueWithAccountsServer).toHaveBeenCalledOnce();
  expect(continueWithSso).not.toHaveBeenCalled();
  expect(addAccountServer).toHaveBeenCalledWith(
    remote.url,
    JSON.stringify([identity.issuer, identity.subject]),
  );
});

it("finishes verified product login when its auth browser returns to the foreground", async () => {
  let finish: (value: boolean) => void = () => undefined;
  vi.mocked(continueWithSso).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  receiveServerConnect(`orkbot://connect?server=${encodeURIComponent(remote.url)}`);
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  await render();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  expect(addAccountServer).not.toHaveBeenCalled();
  await act(async () => {
    for (const listener of state.appListeners) listener("active");
    finish(true);
  });
  expect(addAccountServer).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Product screen");
});

it("does not save a pending login under a newly selected central account", async () => {
  let finish: (value: boolean) => void = () => undefined;
  vi.mocked(continueWithSso).mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  receiveServerConnect(`orkbot://connect?server=${encodeURIComponent(remote.url)}`);
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  await render();
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  await act(async () => {
    vi.mocked(accountsIdentity).mockResolvedValue({ ...identity, subject: "subject-b" });
    state.version++;
    for (const listener of state.listeners) listener();
  });
  await act(async () => finish(true));
  expect(addAccountServer).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Product screen");
  expect(pendingServerConnect()).toBe(remote.url);
});

it("interrupts a mounted product for a warm link and restores the saved server after cancelled login", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  const account = JSON.stringify([identity.issuer, identity.subject]);
  state.storage.set("orkbot.accounts.product-owner", account);
  state.storage.set("orkbot.accounts.selected-server", `${account}:${remote.id}`);
  vi.mocked(saveApiBase).mockImplementation(async (url) => {
    vi.mocked(currentApiBase).mockReturnValue(url);
    return { ok: true, url };
  });
  await render();
  expect(host.textContent).toContain("Product screen");
  const incoming = "https://other.example.test";
  await act(async () => {
    expect(
      redirectSystemPath({
        path: `orkbot://connect?server=${encodeURIComponent(incoming)}`,
        initial: false,
      }),
    ).toBe("/");
  });
  expect(host.textContent).not.toContain("Product screen");
  expect((host.querySelector("input") as HTMLInputElement).value).toBe(incoming);
  vi.mocked(continueWithSso).mockResolvedValue(false);
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === "Add")!.click(),
  );
  expect(addAccountServer).not.toHaveBeenCalled();
  expect(state.storage.get("orkbot.accounts.selected-server")).toBe(`${account}:${remote.id}`);
  expect(host.textContent).not.toContain("Product screen");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((item) => item.textContent === "server.example.test")!
      .click(),
  );
  expect(currentApiBase()).toBe(remote.url);
  expect(pendingServerConnect()).toBeNull();
  expect(host.textContent).toContain("Product screen");
});
