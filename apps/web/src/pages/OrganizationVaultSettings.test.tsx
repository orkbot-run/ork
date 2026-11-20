// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  workspaces: vi.fn(),
  setWorkspaceAccess: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((out, part, i) => `${out}${i ? values[i - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/space-rpc", () => ({ useBoundSpaceId: () => null, useSpaceRpc: () => api }));
vi.mock("../lib/rpc", () => ({
  captureRpcContext: () => ({ client: { organizationVault: api }, isCurrent: () => true }),
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    organizationVault: Object.fromEntries(
      ["context", "list", "workspaces"].map((name) => [
        name,
        {
          queryOptions: () => ({
            queryKey: [name],
            queryFn: api[name as "context" | "list" | "workspaces"],
          }),
        },
      ]),
    ),
  }),
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    />
  ),
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ render }: { render: ReactNode }) => render,
}));
vi.mock("../components/vault/VaultItemEditor", () => ({
  VaultItemEditorPage: () => <div>Editor</div>,
}));
vi.mock("../components/ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: (action: () => Promise<unknown>) => action(),
    identityDialog: null,
  }),
}));

import { OrganizationVaultSettings } from "./OrganizationVaultSettings";

describe("organization vault settings", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    api.list.mockResolvedValue([]);
    api.workspaces.mockResolvedValue([
      { id: "space", name: "Team", state: "ready", granted: false },
    ]);
    api.setWorkspaceAccess.mockResolvedValue({ ok: true });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <OrganizationVaultSettings />
        </QueryClientProvider>,
      ),
    );
    await flush();
    await flush();
  };
  it("keeps the Personal exception in personal settings", async () => {
    api.context.mockResolvedValue({ kind: "personal" });
    await render();
    expect(container.textContent).toContain("Personal organizations use your personal vault");
    expect(api.list).not.toHaveBeenCalled();
    expect(api.workspaces).not.toHaveBeenCalled();
  });
  it("shows workspace access and applies an administrator's grant", async () => {
    api.context.mockResolvedValue({ kind: "shared" });
    await render();
    expect(container.textContent).toContain("Team");
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle?.click());
    await flush();
    expect(api.setWorkspaceAccess).toHaveBeenCalledWith({ spaceId: "space", allowed: true });
  });
});
