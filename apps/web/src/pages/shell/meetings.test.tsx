// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  leave: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (value, part, index) => value + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({ variant: _, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../../lib/space-rpc", () => ({ useSpaceRpc: () => ({ meetings: mocks }) }));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    meetings: Object.fromEntries(
      ["status", "list", "get"].map((name) => [
        name,
        {
          queryOptions: ({ input }: { input?: unknown } = {}) => ({
            queryKey: [name, input],
            queryFn: () => mocks[name as "status" | "list" | "get"](input),
          }),
        },
      ]),
    ),
  }),
}));

import { Meetings } from "./meetings";

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
const meeting = {
  id: "meeting-1",
  botId: "bot-1",
  title: "Design review",
  platform: "google_meet",
  status: "completed",
  scheduledAt: null,
  createdAt: "2026-11-20T12:00:00Z",
  updatedAt: "2026-11-20T12:10:00Z",
  error: null,
};
const meetingDetail = {
  ...meeting,
  transcript: [{ speaker: "Ada", startMs: 61000, endMs: 65000, text: "Ship the small version." }],
};
async function waitFor(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    assertion();
  });
}
async function render(url = "") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Meetings botId="bot-1" initialUrl={url} />
      </QueryClientProvider>,
    ),
  );
  await waitFor(() => {
    expect(
      container.querySelector("section") ||
        container.textContent?.includes("Meetings are not available on this server."),
    ).toBeTruthy();
  });
}
async function click(label: string) {
  let button: HTMLButtonElement | undefined;
  await waitFor(() => {
    button = Array.from(container.querySelectorAll("button")).find((entry) =>
      entry.textContent?.includes(label),
    );
    expect(button).toBeTruthy();
  });
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status.mockResolvedValue({ enabled: true, dailyLimit: 10, maxMinutes: 60 });
  mocks.list.mockResolvedValue([]);
  mocks.get.mockResolvedValue(meetingDetail);
  mocks.create.mockResolvedValue(meeting);
  mocks.leave.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
describe("Meetings", () => {
  it("keeps creation behind explicit participant consent", async () => {
    await render("https://meet.google.com/abc-defg-hij");
    expect(mocks.create).not.toHaveBeenCalled();
    await click("Join meeting");
    expect(mocks.create).not.toHaveBeenCalled();
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await click("Join meeting");
    expect(mocks.create).toHaveBeenCalledWith({
      botId: "bot-1",
      url: "https://meet.google.com/abc-defg-hij",
      title: undefined,
      scheduledAt: undefined,
      confirmed: true,
    });
  });
  it("rejects unsupported domains without creating a meeting", async () => {
    await render("https://meet.google.com.example.com/abc-defg-hij");
    await act(async () =>
      (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await click("Join meeting");
    expect(container.querySelector('[aria-invalid="true"]')).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("shows speaker timings and requires confirmation before deleting", async () => {
    mocks.list.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return [meeting];
    });
    mocks.get.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return meetingDetail;
    });
    await render();
    await click("Design review");
    await waitFor(() => {
      expect(container.textContent).toContain("Ada");
      expect(container.textContent).toContain("1:01–1:05");
      expect(container.textContent).toContain("Ship the small version.");
    });
    await click("Delete meeting");
    expect(mocks.remove).not.toHaveBeenCalled();
    await click("Confirm deletion");
    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith({ meetingId: "meeting-1" });
    });
  });
  it("gates the join form and list when the server has disabled meetings", async () => {
    mocks.status.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { enabled: false, dailyLimit: 10, maxMinutes: 60 };
    });
    await render();
    expect(container.querySelector("form")).toBeNull();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
