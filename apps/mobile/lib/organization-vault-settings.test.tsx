// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ send: vi.fn(), kind: "shared" }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) };
});
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Alert: { alert: vi.fn() },
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/load-failure", () => ({
  LoadFailure: ({ message }: { message: string }) => <p>{message}</p>,
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({ title }: { title: string }) => <div>{title}</div>,
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)}>
      {label}
    </button>
  ),
}));
vi.mock("../components/vault-item-editor", () => ({ VaultItemEditor: () => null }));
vi.mock("../components/confirm-identity", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: (action: () => Promise<unknown>) => action(),
    identityDialog: null,
  }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./native", () => ({
  native: {},
  useResolvedAppearance: () => "dark",
  useThemedStyles: (factory: () => unknown) => factory(),
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./settings-target", () => ({
  ACCOUNT_SETTINGS: {},
  captureSettingsContext: () => ({ send: fixture.send, isCurrent: () => true }),
}));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    rpcQuery: (name: string) => ({ queryKey: [name] }),
  };
});

import OrganizationVaultScreen from "../app/(settings)/organization-vault";
import { queryClient } from "./query";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  fixture.send.mockReset().mockImplementation(async (path: string) => {
    if (path === "organizationVault/context") return { kind: fixture.kind };
    if (path === "organizationVault/list") return [];
    if (path === "organizationVault/workspaces")
      return [{ id: "space", name: "Team", state: "ready", granted: false }];
    if (path === "organizationVault/setWorkspaceAccess") return { ok: true };
    throw new Error("Unexpected request");
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => root.render(<OrganizationVaultScreen />));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
it("lets an administrator grant a workspace access", async () => {
  fixture.kind = "shared";
  await render();
  const button = container.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(button?.textContent).toBe("Team");
  await act(async () => button?.click());
  expect(fixture.send).toHaveBeenCalledWith("organizationVault/setWorkspaceAccess", {
    spaceId: "space",
    allowed: true,
  });
});
it("directs Personal organizations to the personal vault without reading shared secrets", async () => {
  fixture.kind = "personal";
  await render();
  expect(container.textContent).toContain("Personal organizations use your personal vault");
  expect(fixture.send).not.toHaveBeenCalledWith("organizationVault/list");
});
