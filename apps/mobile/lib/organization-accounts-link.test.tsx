// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  open: vi.fn(async (_url: string) => {}),
  organizationId: "00000000-0000-4000-8000-000000000001",
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { managed: true } }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("react-native", () => ({
  Linking: { openURL: fixture.open },
  ActivityIndicator: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/load-failure", () => ({ LoadFailure: () => null }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsInputRow: () => null,
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {title}
    </button>
  ),
}));
vi.mock("./api", () => ({ currentApiBase: () => "https://server.example.test", rpc: vi.fn() }));
vi.mock("./installation-transport", () => ({
  installationRevocationScope: () => ({ target: { organizationId: fixture.organizationId } }),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  native: { secondaryLabel: "", groupedPage: "" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./organizations", () => ({
  activeOrganization: () => null,
  useOrganizations: () => ({}),
}));
vi.mock("./query", () => ({ queryClient: {}, rpcQuery: () => ({}) }));
vi.mock("./settings-sheet", () => ({ openFromSettingsSheet: vi.fn() }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({ errorText: () => "Error" }));

import OrganizationSettings from "../app/(settings)/organization";

it("opens the selected central organization's dashboard in the browser", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<OrganizationSettings />));
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Open Ork Accounts",
    )!;
    await act(async () => button.click());
    expect(fixture.open).toHaveBeenCalledWith(
      `https://app.ork.run/workspace/${fixture.organizationId}/overview`,
    );
    const integrations = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Organization integrations",
    )!;
    await act(async () => integrations.click());
    expect(fixture.open).toHaveBeenCalledWith(
      `https://app.ork.run/workspace/${fixture.organizationId}/integrations`,
    );
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
