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
import { accountsIdentity, continueWithAccounts, signOutAccounts } from "./accounts";
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
import type { MobileServerPairing } from "./server-pairing";
import { beginServerPairing } from "./server-pairing";
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
  Linking: { openURL: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("./server-pairing", () => ({ beginServerPairing: vi.fn() }));
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
let pairing: MobileServerPairing;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pairing = {
    ticket: {
      id: "a".repeat(64),
      code: "AB23CD",
      expiresAt: Date.now() / 1000 + 300,
    },
    state: vi.fn().mockResolvedValue({
      status: "pending",
      origin: null,
      expiresAt: Date.now() / 1000 + 300,
    }),
    approve: vi.fn().mockImplementation(async (origin: string) => {
      vi.mocked(pairing.state).mockResolvedValue({
        status: "ready",
        origin,
        expiresAt: pairing.ticket.expiresAt,
      });
      return { status: "approved", origin, expiresAt: pairing.ticket.expiresAt };
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(beginServerPairing).mockReset().mockResolvedValue(pairing);
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
  vi.unstubAllGlobals();
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
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Pairing code");
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

async function click(label: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((item) => item.textContent === label)!.click(),
  );
}
function setupPairing(status = "pending") {
  receiveServerConnect(`orkbot://connect?server=${encodeURIComponent(remote.url)}`);
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  vi.mocked(requireAccountsSignIn).mockResolvedValue({ accountsLogin: true });
  vi.mocked(pairing.state).mockResolvedValue({
    status: status as "pending" | "approval-required" | "ready",
    origin: status === "pending" ? null : remote.url,
    expiresAt: pairing.ticket.expiresAt,
  });
}

it("retains a connection link through Accounts login and requires a pairing code before product login", async () => {
  const destination = redirectSystemPath({
    path: `orkbot://connect?server=${encodeURIComponent(remote.url)}`,
    initial: false,
  });
  expect(destination).toBe("/");
  await render();
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  await act(async () => {
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).not.toContain("Product screen");
  expect(beginServerPairing).not.toHaveBeenCalled();
  await click("Pairing code");
  expect(beginServerPairing).toHaveBeenCalledWith(
    JSON.stringify([identity.issuer, identity.subject]),
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("AB2 3CD");
  expect(probeApiBase).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  expect(continueWithSso).not.toHaveBeenCalled();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(addAccountServer).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("automatically refreshes the directory and enters the paired server when ready", async () => {
  setupPairing("approval-required");
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(accountServers).toHaveBeenNthCalledWith(
    2,
    JSON.stringify([identity.issuer, identity.subject]),
  );
  expect(continueWithAccountsServer).toHaveBeenCalledOnce();
  expect(continueWithSso).not.toHaveBeenCalled();
  expect(addAccountServer).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("me");
  expect(pendingServerConnect()).toBeNull();
  expect(host.textContent).toContain("Product screen");
});

it.each(["cancel", "rejected", "session-change"])(
  "never enters an unverified paired product session (%s)",
  async (outcome) => {
    setupPairing("approval-required");
    if (outcome === "cancel") vi.mocked(continueWithAccountsServer).mockResolvedValue(false);
    if (outcome === "rejected") vi.mocked(rpc).mockRejectedValue(new Error("Not admitted"));
    if (outcome === "session-change")
      vi.mocked(rpc).mockImplementationOnce(async () => {
        vi.mocked(currentSessionGeneration).mockReturnValue(2);
        return { userId: "product-user" } as never;
      });
    await render();
    await click("Pairing code");
    await click("Approve server");
    expect(addAccountServer).not.toHaveBeenCalled();
    expect(pendingServerConnect()).toBe(remote.url);
    expect(host.textContent).not.toContain("Product screen");
  },
);

it("never logs in before Accounts lists the paired origin", async () => {
  setupPairing("approval-required");
  vi.mocked(accountServers).mockResolvedValueOnce([remote]).mockResolvedValueOnce([]);
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Product screen");
});

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

it("keeps the code while backgrounded and resumes polling when the server browser returns", async () => {
  setupPairing();
  await render();
  await click("Pairing code");
  await act(async () => {
    for (const listener of state.appListeners) listener("background");
  });
  const polls = vi.mocked(pairing.state).mock.calls.length;
  vi.mocked(pairing.state).mockResolvedValue({
    status: "approval-required",
    origin: remote.url,
    expiresAt: pairing.ticket.expiresAt,
  });
  expect(pairing.cancel).not.toHaveBeenCalled();
  expect(host.textContent).toContain("AB2 3CD");
  expect(vi.mocked(pairing.state).mock.calls.length).toBe(polls);
  await act(async () => {
    for (const listener of state.appListeners) listener("active");
  });
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(host.textContent).toContain(remote.url);
  await click("Approve server");
  expect(continueWithAccountsServer).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Product screen");
});

it("cancels the pending code when another central account becomes active", async () => {
  setupPairing();
  await render();
  await click("Pairing code");
  await act(async () => {
    vi.mocked(accountsIdentity).mockResolvedValue({ ...identity, subject: "subject-b" });
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("AB2 3CD");
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Product screen");
});

it("cancels a creation that finishes after the account changes", async () => {
  setupPairing();
  let finish!: (value: MobileServerPairing) => void;
  vi.mocked(beginServerPairing).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Pairing code");
  const signal = vi.mocked(beginServerPairing).mock.calls[0]![1]!;
  await act(async () => {
    vi.mocked(accountsIdentity).mockResolvedValue({ ...identity, subject: "subject-b" });
    state.version++;
    for (const listener of state.listeners) listener();
  });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(pairing));
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("AB2 3CD");
  expect(saveApiBase).not.toHaveBeenCalled();
});

it.each(["cancel", "unmount", "expired", "server-change"])(
  "clears and revokes the code on %s",
  async (reason) => {
    setupPairing();
    if (reason === "expired")
      vi.mocked(pairing.state).mockResolvedValue({
        status: "expired",
        origin: remote.url,
        expiresAt: pairing.ticket.expiresAt,
      });
    await render();
    await click("Pairing code");
    if (reason === "cancel") await click("Cancel");
    if (reason === "unmount") await act(async () => root.render(null));
    if (reason === "server-change") {
      await act(async () => {
        for (const listener of state.appListeners) listener("background");
      });
      vi.mocked(currentApiBase).mockReturnValue("https://different.example.test");
      await act(async () => {
        for (const listener of state.appListeners) listener("active");
      });
    }
    expect(pairing.cancel).toHaveBeenCalledOnce();
    expect(host.textContent).not.toContain("AB2 3CD");
    expect(continueWithAccountsServer).not.toHaveBeenCalled();
    if (reason === "expired") expect(host.textContent).toContain("Pairing code expired");
  },
);

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
        path: `orkbot://initialize?server=${encodeURIComponent(incoming)}&secret=${"s".repeat(43)}`,
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

it("revokes the pairing before signing out", async () => {
  setupPairing();
  await render();
  await click("Pairing code");
  await click("Sign out");
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(signOutAccounts).toHaveBeenCalledOnce();
  expect(vi.mocked(pairing.cancel).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(signOutAccounts).mock.invocationCallOrder[0]!,
  );
  expect(host.textContent).not.toContain("AB2 3CD");
});

it("ignores ready from a cancelled status request", async () => {
  setupPairing();
  let finish!: (value: Awaited<ReturnType<MobileServerPairing["state"]>>) => void;
  vi.mocked(pairing.state).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Pairing code");
  const signal = vi.mocked(pairing.state).mock.calls[0]![0]!;
  await click("Cancel");
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({ status: "ready", origin: remote.url, expiresAt: pairing.ticket.expiresAt }),
  );
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Product screen");
});

it("does not create a product session on an older server after pairing", async () => {
  setupPairing("approval-required");
  vi.mocked(requireAccountsSignIn).mockResolvedValue({ accountsLogin: false });
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(continueWithSso).not.toHaveBeenCalled();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Update it and try again");
});

it.each(["server", "product-session"])(
  "revokes late code creation after %s changes",
  async (kind) => {
    setupPairing();
    let finish!: (value: MobileServerPairing) => void;
    vi.mocked(beginServerPairing).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click("Pairing code");
    if (kind === "server") vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
    else vi.mocked(currentSessionGeneration).mockReturnValue(2);
    await act(async () => finish(pairing));
    expect(pairing.cancel).toHaveBeenCalledOnce();
    expect(pairing.state).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("AB2 3CD");
  },
);

it("generates a code without a URL field or incoming server link", async () => {
  vi.mocked(accountsIdentity).mockResolvedValue(identity);
  vi.mocked(accountServers).mockResolvedValue([]);
  await render();
  expect(host.querySelector("input")).toBeNull();
  await click("Pairing code");
  expect(beginServerPairing).toHaveBeenCalledWith(
    JSON.stringify([identity.issuer, identity.subject]),
    expect.any(AbortSignal),
  );
  expect(host.textContent).toContain("AB2 3CD");
  expect(host.textContent).not.toContain("Approve server");
  expect(saveApiBase).not.toHaveBeenCalled();
});

it("shows the complete claimed origin and waits for explicit approval", async () => {
  setupPairing("approval-required");
  await render();
  await click("Pairing code");
  expect(host.textContent).toContain(remote.url);
  expect(host.textContent).not.toContain("AB2 3CD");
  expect(pairing.approve).not.toHaveBeenCalled();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
  await click("Approve server");
  expect(pairing.approve).toHaveBeenCalledWith(remote.url, expect.any(AbortSignal));
  expect(continueWithAccountsServer).toHaveBeenCalledOnce();
});

it.each(["approved", "ready"])(
  "rejects an unsolicited %s without product requests",
  async (value) => {
    setupPairing();
    vi.mocked(pairing.state).mockResolvedValue({
      status: value as "ready" | "approved",
      origin: remote.url,
      expiresAt: pairing.ticket.expiresAt,
    });
    await render();
    await click("Pairing code");
    expect(pairing.cancel).toHaveBeenCalledOnce();
    expect(pairing.approve).not.toHaveBeenCalled();
    expect(continueWithAccountsServer).not.toHaveBeenCalled();
    expect(saveApiBase).not.toHaveBeenCalled();
  },
);

it("rejects a replacement domain instead of asking to approve another server", async () => {
  setupPairing("approval-required");
  vi.mocked(pairing.state)
    .mockResolvedValueOnce({
      status: "approval-required",
      origin: remote.url,
      expiresAt: pairing.ticket.expiresAt,
    })
    .mockResolvedValue({
      status: "approval-required",
      origin: "https://other.example.test",
      expiresAt: pairing.ticket.expiresAt,
    });
  await render();
  await click("Pairing code");
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("https://other.example.test");
  expect(pairing.approve).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
});

it("rejects ready for a domain other than the approved origin", async () => {
  setupPairing("approval-required");
  vi.mocked(pairing.approve).mockImplementation(async (origin) => {
    vi.mocked(pairing.state).mockResolvedValue({
      status: "ready",
      origin: "https://other.example.test",
      expiresAt: pairing.ticket.expiresAt,
    });
    return { status: "approved", origin, expiresAt: pairing.ticket.expiresAt };
  });
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
});

it.each(["account-change", "cancel", "unmount"])(
  "ignores a late approval after %s",
  async (reason) => {
    setupPairing("approval-required");
    let finish!: (value: Awaited<ReturnType<MobileServerPairing["approve"]>>) => void;
    vi.mocked(pairing.approve).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click("Pairing code");
    await click("Approve server");
    const signal = vi.mocked(pairing.approve).mock.calls[0]![1]!;
    if (reason === "account-change")
      await act(async () => {
        vi.mocked(accountsIdentity).mockResolvedValue({ ...identity, subject: "subject-b" });
        state.version++;
        for (const listener of state.listeners) listener();
      });
    else if (reason === "cancel") await click("Cancel");
    else await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish({ status: "approved", origin: remote.url, expiresAt: pairing.ticket.expiresAt }),
    );
    expect(pairing.cancel).toHaveBeenCalledOnce();
    expect(continueWithAccountsServer).not.toHaveBeenCalled();
    expect(saveApiBase).not.toHaveBeenCalled();
  },
);

it("waits for ready after approval without repeating the approval prompt", async () => {
  setupPairing("approval-required");
  vi.mocked(pairing.approve).mockImplementation(async (origin) => {
    vi.mocked(pairing.state).mockResolvedValue({
      status: "approved",
      origin,
      expiresAt: pairing.ticket.expiresAt,
    });
    return { status: "approved", origin, expiresAt: pairing.ticket.expiresAt };
  });
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(host.textContent).not.toContain("Approve server");
  expect(host.textContent).toContain(remote.url);
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  await act(async () => {
    for (const listener of state.appListeners) listener("background");
  });
  vi.mocked(pairing.state).mockResolvedValue({
    status: "ready",
    origin: remote.url,
    expiresAt: pairing.ticket.expiresAt,
  });
  await act(async () => {
    for (const listener of state.appListeners) listener("active");
  });
  expect(continueWithAccountsServer).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Product screen");
});

it("does not replace a new code with a cancelled approval result", async () => {
  setupPairing("approval-required");
  const previous = pairing;
  const replacement: MobileServerPairing = {
    ticket: { ...pairing.ticket, id: "b".repeat(64), code: "EF45GH" },
    state: vi
      .fn()
      .mockResolvedValue({ status: "pending", origin: null, expiresAt: pairing.ticket.expiresAt }),
    approve: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  let finish!: (value: Awaited<ReturnType<MobileServerPairing["approve"]>>) => void;
  vi.mocked(previous.approve).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(beginServerPairing).mockResolvedValueOnce(previous).mockResolvedValueOnce(replacement);
  await render();
  await click("Pairing code");
  await click("Approve server");
  await click("Cancel");
  await click("Pairing code");
  await act(async () =>
    finish({ status: "approved", origin: remote.url, expiresAt: previous.ticket.expiresAt }),
  );
  expect(host.textContent).toContain("EF4 5GH");
  expect(previous.cancel).toHaveBeenCalledOnce();
  expect(replacement.cancel).not.toHaveBeenCalled();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
});

it("shows an approval failure without allowing product login", async () => {
  setupPairing("approval-required");
  vi.mocked(pairing.approve).mockRejectedValueOnce(
    new Error("Could not pair this server. Try again."),
  );
  await render();
  await click("Pairing code");
  await click("Approve server");
  expect(host.textContent).toContain("Could not pair this server. Try again.");
  expect(pairing.cancel).toHaveBeenCalledOnce();
  expect(continueWithAccountsServer).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
});
