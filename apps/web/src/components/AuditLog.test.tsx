// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { AuditEvent } from "@orkbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: parts }, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Spinner: (props: ComponentProps<"svg">) => <svg {...props} />,
}));

import type { AuditLogProps } from "./AuditLog";
import { AuditLog } from "./AuditLog";

const event: AuditEvent = {
  id: "event-2",
  createdAt: "2026-01-02T12:34:56Z",
  organizationId: "org-1",
  spaceId: null,
  spaceName: null,
  actorType: "user",
  actorId: "user-1",
  actorLabel: "Alice",
  action: "credential.created",
  targetType: "credential",
  targetId: "credential-1",
  targetLabel: "Calendar",
  outcome: "success",
  runId: null,
  threadId: null,
  ip: null,
  userAgent: null,
  metadata: { connectorId: "google", connectionId: "connection-1" },
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function mounted(overrides: Partial<AuditLogProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const props: AuditLogProps = {
    events: [event],
    loading: false,
    loadFailed: false,
    loadingMore: false,
    hasMore: false,
    onRetry: vi.fn(),
    onLoadMore: vi.fn(),
    onExport: vi.fn().mockResolvedValue(undefined),
    timezone: "Europe/Warsaw",
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (updates: Partial<AuditLogProps> = {}) => {
    Object.assign(props, updates);
    await act(async () => root.render(<AuditLog {...props} />));
  };
  await render();
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === name)!;
  return { container, props, render, button };
}

it("keeps supplied newest-first rows and separate actor, action, target, outcome and connector fields", async () => {
  const second: AuditEvent = {
    ...event,
    id: "event-1",
    actorLabel: null,
    targetLabel: null,
    outcome: "denied",
    metadata: {},
  };
  const view = await mounted({ events: [event, second] });
  const rows = [...view.container.querySelectorAll('[data-testid="audit-event"]')];
  const fields = (row: Element) =>
    [...row.querySelectorAll("dl > div")].map((item) => [
      item.querySelector("dt")!.textContent,
      [...item.querySelectorAll("dd")].map((dd) => dd.textContent),
    ]);
  expect(fields(rows[0]!)).toEqual([
    ["Actor", ["Alice", "User"]],
    ["Action", ["credential.created"]],
    ["Target", ["Calendar", "credential"]],
    ["Outcome", ["Success"]],
    [
      "Time",
      [
        new Intl.DateTimeFormat("en", {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone: "Europe/Warsaw",
        }).format(new Date(event.createdAt)),
      ],
    ],
    ["Connector ID", ["google"]],
    ["Connection ID", ["connection-1"]],
  ]);
  expect(fields(rows[1]!)).toContainEqual(["Actor", ["user-1", "User"]]);
  expect(fields(rows[1]!)).toContainEqual(["Target", ["credential-1", "credential"]]);
  expect(rows[1]!.textContent).toContain("Denied");
  expect(rows[1]!.textContent).not.toContain("Connector ID");
});

it("renders stable profile-local timestamps and browser-local fallback", async () => {
  const view = await mounted();
  const expected = (timeZone?: string) =>
    new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "medium",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(event.createdAt));
  expect(view.container.querySelector("time")!.getAttribute("datetime")).toBe(event.createdAt);
  expect(view.container.querySelector("time")!.textContent).toBe(expected("Europe/Warsaw"));
  await view.render({ timezone: "America/New_York" });
  expect(view.container.querySelector("time")!.textContent).toBe(expected("America/New_York"));
  await view.render({ timezone: null });
  expect(view.container.querySelector("time")!.textContent).toBe(expected());
  await view.render({ timezone: "invalid/profile-zone" });
  expect(view.container.querySelector("time")!.textContent).toBe(expected());
});

it("calls paging and retry and prevents duplicate paging while loading", async () => {
  const view = await mounted({ hasMore: true });
  await act(async () => view.button("Load more").click());
  expect(view.props.onLoadMore).toHaveBeenCalledOnce();
  await view.render({ loadingMore: true });
  expect(view.button("Loading…").disabled).toBe(true);
  await act(async () => view.button("Loading…").click());
  expect(view.props.onLoadMore).toHaveBeenCalledOnce();
  await view.render({ loadingMore: false, loadFailed: true });
  expect(view.container.querySelector('[role="alert"]')!.textContent).toContain(
    "Could not load activity log",
  );
  await act(async () => view.button("Retry").click());
  expect(view.props.onRetry).toHaveBeenCalledOnce();
  expect(view.container.querySelectorAll('[data-testid="audit-event"]')).toHaveLength(1);
  await view.render({ hasMore: false });
  expect(view.button("Load more")).toBeUndefined();
});

it("distinguishes loading, empty and failed initial loads", async () => {
  const view = await mounted({ events: [], loading: true });
  expect(view.container.querySelector('[role="status"]')!.textContent).toContain(
    "Loading activity log…",
  );
  expect(view.container.textContent).not.toContain("No activity yet");
  await view.render({ loading: false });
  expect(view.container.textContent).toContain("No activity yet");
  await view.render({ loadFailed: true });
  expect(view.container.textContent).not.toContain("No activity yet");
  expect(view.button("Retry")).toBeDefined();
});

it("keeps export failures visible until successful retry and prevents concurrent exports", async () => {
  let finish: (() => void) | undefined;
  const onExport = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  const view = await mounted({ onExport });
  await act(async () => view.button("Export").click());
  expect(view.container.querySelector('[role="alert"]')!.textContent).toBe(
    "Could not export activity log. Try again.",
  );
  await view.render();
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => {
    view.button("Export").click();
    view.button("Export").click();
  });
  expect(onExport).toHaveBeenCalledTimes(2);
  expect(view.button("Exporting…").disabled).toBe(true);
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => finish!());
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.button("Export").disabled).toBe(false);
});

it("aborts an in-flight export when the selected audit view unmounts", async () => {
  let signal: AbortSignal | undefined;
  const view = await mounted({
    onExport: (exportSignal) => {
      signal = exportSignal;
      return new Promise<void>((_resolve, reject) => {
        exportSignal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  });
  await act(async () => view.button("Export").click());
  expect(signal!.aborted).toBe(false);
  await cleanups.pop()!();
  expect(signal!.aborted).toBe(true);
});
