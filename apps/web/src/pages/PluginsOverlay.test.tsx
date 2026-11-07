// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
// @vitest-environment jsdom

import type { SourcePreset } from "@orkbot/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginsOverlay } from "./PluginsOverlay";

const state = vi.hoisted(() => ({ generation: 0, call: vi.fn() }));
vi.mock("../lib/rpc", async () => {
  const { createORPCClient } = await import("@orpc/client");
  const rpc = createORPCClient({ call: (path, input) => state.call(path.join("/"), input) });
  return {
    rpc,
    captureRpcContext: () => {
      const generation = state.generation;
      const isCurrent = () => generation === state.generation;
      const client = createORPCClient({
        call: async (path, input) => {
          if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
          const result = await state.call(path.join("/"), input);
          if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
          return result;
        },
      });
      return { client, isCurrent };
    },
  };
});
vi.mock("../lib/query", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  const { rpc } = await import("../lib/rpc");
  const queries = createTanstackQueryUtils(rpc, { path: ["fixture"] });
  return { useSpaceQueries: () => queries };
});
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + String(values[index] ?? ""), ""),
  }),
}));
vi.mock("../components/integrations/space-availability", () => ({
  useOwnSpaces: () => [],
  reachesOtherSpaces: () => false,
  AvailabilityControl: () => null,
  AvailabilityLabel: () => null,
}));
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("@orkbot/ui-web", async () => {
  const actual = await vi.importActual<typeof import("@orkbot/ui-web")>("@orkbot/ui-web");
  const contents = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...actual,
    Dialog: contents,
    DialogContent: contents,
    DialogHeader: contents,
    DialogTitle: contents,
    DialogClose: contents,
    DropdownMenu: contents,
    DropdownMenuContent: contents,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: () => null,
    DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});

const item = {
  connectorId: "fixture",
  slug: "fixture-app",
  name: "Fixture app",
  logo: null,
  connected: true,
  noAuth: false,
};
const account = {
  id: "fixture-account",
  connectorId: "fixture",
  provider: item.slug,
  displayName: "Fixture account",
  status: "connected",
  capabilities: [],
  createdAt: "2026-01-01",
};
const preset: SourcePreset = {
  id: "fixture-source",
  label: "Fixture source",
  kind: "mcp",
  endpoint: "fixed",
  credential: "required",
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.generation = 0;
  state.call.mockReset().mockImplementation(async (path: string) => {
    if (path === "connections/catalogSnapshot")
      return { items: [item], providers: [{ id: item.connectorId, status: "ready" }] };
    if (path === "connections/list") return [account];
    if (path === "capabilities/sourcePresets") return [preset];
    if (path === "capabilities/catalogSearch") return { enabled: false, results: [] };
    if (path === "marketplace/catalog")
      return { entries: [], unavailableRegistries: [], skippedEntries: 0 };
    return [];
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PluginsOverlay onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing fixture action ${label}`);
  await act(async () => button.click());
}
async function credential(value: string) {
  const input = container.querySelector("#source-credential");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing credential field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("submits fetched fixed preset intent without endpoint or protocol overrides", async () => {
  await render();
  await click("Fixture source");
  expect(container.querySelector("#source-url")).toBeNull();
  expect(container.querySelector("#source-auth")).toBeNull();
  await credential("fake-source-token");
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(state.call).toHaveBeenCalledWith("capabilities/install", {
    presetId: preset.id,
    name: preset.label,
    credential: "fake-source-token",
  });
});
it.each(["error", "revoked"])(
  "uses fresh %s rows over cached connected state when its provider fails",
  async (status) => {
    await render();
    const original = state.call.getMockImplementation()!;
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "connections/catalogSnapshot"
        ? Promise.resolve({
            items: [],
            providers: [{ id: item.connectorId, status: "unavailable" }],
          })
        : path === "connections/list"
          ? Promise.resolve([{ ...account, status }])
          : original(path, input),
    );
    await act(async () => client.refetchQueries({ type: "active" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("Fixture app");
    const buttons = [...container.querySelectorAll("button")].map((node) => node.textContent);
    expect(buttons).toContain(status === "error" ? "Reconnect" : "Add");
    expect(buttons).not.toContain("Added");
    expect(container.textContent).toContain("Could not load integrations");
  },
);
it.each(["resolve", "reject"])(
  "releases canceled source pending and fences a late %s from its replacement",
  async (outcome) => {
    await render();
    const original = state.call.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "capabilities/install" ? pending : original(path, input),
    );
    await click("Fixture source");
    await credential("fake-first-token");
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const back = container.querySelector('button[aria-label="Back"]');
    if (!(back instanceof HTMLButtonElement)) throw new Error("Missing back action");
    await act(async () => back.click());
    await click("Fixture source");
    expect(
      [...container.querySelectorAll("button")].find(
        (node) => node.textContent === "Verify and add",
      )?.disabled,
    ).toBe(false);
    await credential("fake-second-token");
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "capabilities/install" ? new Promise(() => {}) : original(path, input),
    );
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await act(async () =>
      outcome === "resolve"
        ? resolve({ id: "retired-source" })
        : reject(new Error("Retired source failure")),
    );
    expect(
      [...container.querySelectorAll("button")].find((node) => node.textContent === "Verifying…")
        ?.disabled,
    ).toBe(true);
    expect((container.querySelector("#source-credential") as HTMLInputElement).value).toBe(
      "fake-second-token",
    );
    expect(container.textContent).not.toContain("Retired source failure");
  },
);
it("clears a removed preset after metadata refresh fails while keeping current accounts", async () => {
  await render();
  await click("Fixture source");
  const original = state.call.getMockImplementation()!;
  state.call.mockImplementation((path: string, input: unknown) =>
    path === "capabilities/sourcePresets"
      ? Promise.reject(new Error("Preset catalog unavailable"))
      : original(path, input),
  );
  await act(async () => client.refetchQueries({ type: "active" }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector("#source-credential")).toBeNull();
  expect(container.textContent).not.toContain("Fixture source");
  expect(container.textContent).toContain("Fixture app");
  expect(container.textContent).toContain("Retry");
});
it("does not let a retired scope's preset completion refresh or navigate the new scope", async () => {
  await render();
  const original = state.call.getMockImplementation()!;
  let complete!: (value: unknown) => void;
  state.call.mockImplementation((path: string, input: unknown) =>
    path === "capabilities/install"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : original(path, input),
  );
  await click("Fixture source");
  await credential("fake-retired-token");
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  state.generation += 1;
  await render();
  const calls = state.call.mock.calls.length;
  await act(async () => complete({ id: "retired-source" }));
  expect(state.call).toHaveBeenCalledTimes(calls);
  expect(container.querySelector("#source-credential")).toBeNull();
});

it.each(["resolve", "reject"])(
  "keeps source edits made during an earlier save %s and clears its busy flag",
  async (outcome) => {
    await render();
    const original = state.call.getMockImplementation()!;
    let complete!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const pending = new Promise((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "capabilities/install" ? pending : original(path, input),
    );
    await click("Fixture source");
    await credential("fake-original-token");
    await act(async () =>
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await credential("fake-edited-token");
    await act(async () =>
      outcome === "resolve"
        ? complete({ id: "accepted-source" })
        : fail(new Error("Earlier save failure")),
    );
    expect((container.querySelector("#source-credential") as HTMLInputElement).value).toBe(
      "fake-edited-token",
    );
    expect(
      [...container.querySelectorAll("button")].find(
        (node) => node.textContent === "Verify and add",
      )?.disabled,
    ).toBe(false);
    expect(container.textContent).not.toContain("Earlier save failure");
  },
);
it("does not publish late preset metadata after its captured context is replaced", async () => {
  const original = state.call.getMockImplementation()!;
  let complete!: (value: unknown) => void;
  state.call.mockImplementation((path: string, input: unknown) =>
    path === "capabilities/sourcePresets"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : original(path, input),
  );
  await render();
  state.generation += 1;
  await render();
  await act(async () => complete([preset]));
  expect(container.textContent).not.toContain("Fixture source");
});
it.each(["ready", "unavailable", "unconfigured"])(
  "distinguishes a cold %s managed catalog outcome",
  async (status) => {
    const original = state.call.getMockImplementation()!;
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "connections/catalogSnapshot"
        ? Promise.resolve({
            items: [],
            providers: status === "unconfigured" ? [] : [{ id: "fixture", status }],
          })
        : path === "connections/list"
          ? Promise.resolve([])
          : original(path, input),
    );
    await render();
    expect(container.textContent?.includes("No results")).toBe(status === "ready");
    expect(container.textContent?.includes("Retry")).toBe(status === "unavailable");
  },
);

it.each(["Remove", "Uninstall"])(
  "keeps an accepted %s revoked locally when its refresh fails",
  async (action) => {
    await render();
    await click("Added");
    const original = state.call.getMockImplementation()!;
    state.call.mockImplementation((path: string, input: unknown) =>
      path === "connections/revoke"
        ? Promise.resolve({ ok: true })
        : path === "connections/catalogSnapshot"
          ? Promise.reject(new Error("Refresh unavailable"))
          : original(path, input),
    );
    await click(action);
    if (action === "Remove") {
      const back = container.querySelector('button[aria-label="Back"]');
      if (!(back instanceof HTMLButtonElement)) throw new Error("Missing back action");
      await act(async () => back.click());
    }
    const buttons = [...container.querySelectorAll("button")].map((node) => node.textContent);
    expect(buttons).not.toContain("Added");
    expect(buttons).toContain("Add");
    expect(container.textContent).toContain("Retry");
  },
);

it("keeps fetched preset metadata owned by the session after saving and opening another source form", async () => {
  await render();
  await click("Fixture source");
  await credential("fake-first-token");
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await click("Fixture source");
  expect(container.querySelector("#source-credential")).not.toBeNull();
  expect((container.querySelector("#source-name") as HTMLInputElement).value).toBe(preset.label);
});
