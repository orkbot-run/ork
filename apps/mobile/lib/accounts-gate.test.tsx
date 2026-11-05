// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { tokensForAppearance } from "@orkbot/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountsGate } from "../components/accounts-gate";
import { accountServers } from "./account-servers";
import { accountsIdentity, continueWithAccounts } from "./accounts";
import { clearProductAccountSession, loadApiBase, probeApiBase, saveApiBase } from "./api";
import type * as Endpoint from "./endpoint";
import { requireAccountsSignIn } from "./endpoint";

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  version: 0,
  listeners: new Set<() => void>(),
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
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  ActivityIndicator: () => <span>Loading</span>,
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
  requireAccountsSignIn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./accounts", () => ({
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
vi.mock("./api", () => ({
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
  state.storage.clear();
  state.version = 0;
  state.listeners.clear();
  vi.mocked(accountsIdentity).mockResolvedValue(null);
  vi.mocked(accountServers).mockResolvedValue([remote]);
  vi.mocked(clearProductAccountSession).mockResolvedValue(undefined);
  vi.mocked(saveApiBase).mockResolvedValue({ ok: true, url: remote.url });
  vi.mocked(probeApiBase).mockResolvedValue({ ok: true, url: remote.url });
  vi.mocked(requireAccountsSignIn).mockResolvedValue(undefined);
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
  expect(host.textContent).toContain("Continue with Accounts");
  expect(host.textContent).not.toContain("Product screen");
  expect(host.querySelector("input")).toBeNull();
  expect(accountServers).not.toHaveBeenCalled();
  expect(loadApiBase).not.toHaveBeenCalled();
  expect(probeApiBase).not.toHaveBeenCalled();
  expect(saveApiBase).not.toHaveBeenCalled();
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
  expect(host.textContent).toContain("Continue with Accounts");
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
