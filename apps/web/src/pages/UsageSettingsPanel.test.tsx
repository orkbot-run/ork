// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { UsageBreakdown } from "@orkbot/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.flatMap((part, i) => [part, values[i] ?? ""]).join(""),
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    usage: {
      breakdown: {
        queryOptions: ({ input }: { input: object }) => ({
          queryKey: ["usage", input],
          queryFn: () => load(input),
        }),
      },
    },
  }),
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  NativeSelect: ({ className: _c, ...props }: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
}));

import { UsageSettingsPanel } from "./UsageSettingsPanel";

const totals = {
  runs: 2,
  modelCalls: 3,
  inputTokens: 1200,
  outputTokens: 34,
  totalTokens: 1234,
  costUsd: null,
};
const fixture: UsageBreakdown = {
  timezone: "Europe/Warsaw",
  range: "30d",
  from: "2026-10-22T00:00:00.000Z",
  to: "2026-11-20T12:00:00.000Z",
  totals,
  botOptions: [{ botId: "deleted-bot", name: "Old bot", deleted: true }],
  modelOptions: [{ provider: "local", model: "model-a" }],
  bots: [{ botId: "deleted-bot", name: "Old bot", deleted: true, ...totals }],
  models: [{ provider: "local", model: "model-a", ...totals }],
  overTimeUnit: "day",
  overTime: [{ date: "2026-11-20", ...totals }],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  load.mockReset();
});
async function renderPanel() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <UsageSettingsPanel />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return container;
}

it("shows known totals, unknown cost and accessible breakdown values including deleted bots", async () => {
  load.mockResolvedValue(fixture);
  const container = await renderPanel();
  expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([
    "2",
    "3",
    "1,200",
    "34",
    "—",
  ]);
  expect(container.querySelector('[data-testid="usage-bots"]')?.textContent).toContain(
    "Old botDeleted",
  );
  expect(container.querySelector('[data-testid="usage-timeline-data"]')?.textContent).toContain(
    "1,200",
  );
  expect(
    container
      .querySelector('[data-testid="usage-timeline"] [role="img"]')
      ?.getAttribute("aria-label"),
  ).toContain("Exact values");
  expect(container.textContent).toContain("Europe/Warsaw");
  expect(container.textContent).not.toContain("$0");
});

it("requests range, deleted bot and provider/model filters together", async () => {
  load.mockResolvedValue(fixture);
  const container = await renderPanel();
  async function select(id: string, value: string) {
    await act(async () => {
      const node = container.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement;
      node.value = value;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  await select("usage-range", "7d");
  await select("usage-bot", "deleted-bot");
  await select("usage-model", JSON.stringify(["local", "model-a"]));
  expect(load).toHaveBeenLastCalledWith({
    range: "7d",
    botId: "deleted-bot",
    provider: "local",
    model: "model-a",
  });
  await select("usage-range", "today");
  expect(load).toHaveBeenLastCalledWith({ range: "today" });
});

it("distinguishes empty usage from loading and request errors", async () => {
  load.mockResolvedValue({
    ...fixture,
    totals: { ...totals, runs: 0, modelCalls: 0 },
    bots: [],
    models: [],
    overTime: [],
  });
  const empty = await renderPanel();
  expect(empty.querySelector('[data-testid="usage-empty"]')).not.toBeNull();
  expect(empty.querySelector('[data-testid="usage-loading"]')).toBeNull();
  load.mockRejectedValue(new Error("Unavailable"));
  const failed = await renderPanel();
  expect(failed.querySelector('[data-testid="usage-error"]')?.textContent).toContain(
    "Could not load usage",
  );
  expect(failed.querySelector('[data-testid="usage-totals"]')).toBeNull();
});
