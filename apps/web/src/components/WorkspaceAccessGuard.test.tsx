// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceAccessGuard } from "./WorkspaceAccessGuard";

const fixture = vi.hoisted(() => ({
  check: vi.fn(),
  list: vi.fn(),
  change: vi.fn(),
  selected: null as string | null,
  current: true,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/desktop", () => ({
  desktopBridge: () => ({
    accounts: { workspaceAccess: fixture.check },
    server: { change: fixture.change },
  }),
}));
vi.mock("../lib/rpc", () => ({
  captureRpcContext: () => ({
    client: { spaces: { accessStatus: fixture.list } },
    isCurrent: () => fixture.current,
  }),
  forgetSelectedSpace: () => window.localStorage.removeItem("orkbot:space-id"),
  selectedSpaceId: () => fixture.selected,
  SPACE_UNAVAILABLE_NOTICE_KEY: "orkbot:space-unavailable-notice",
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  fixture.selected = null;
  fixture.current = true;
  fixture.check.mockReset().mockResolvedValue(true);
  fixture.list.mockReset().mockResolvedValue("available");
  fixture.change.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

it("retires the product and offers the picker when the managed workspace is revoked", async () => {
  fixture.check.mockResolvedValueOnce(true).mockResolvedValue(false);
  window.localStorage.setItem("orkbot:space-id", "workspace");
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  expect(container.textContent).toContain("Private chat");
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.textContent).not.toContain("Private chat");
  expect(container.textContent).toContain("This workspace was closed or your access was removed.");
  expect(window.localStorage.getItem("orkbot:space-id")).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  expect(fixture.change).toHaveBeenCalledOnce();
});

it("leaves a selected workspace only after the server confirms removal", async () => {
  fixture.selected = "workspace";
  fixture.list.mockResolvedValue("removed");
  window.localStorage.setItem("orkbot:space-id", "workspace");
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  expect(container.textContent).not.toContain("Private chat");
  expect(container.textContent).toContain("Workspace unavailable");
});

it("does not treat a directory outage as a revocation", async () => {
  fixture.check.mockRejectedValue(new Error("offline"));
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(container.textContent).toContain("Private chat");
  expect(fixture.change).not.toHaveBeenCalled();
});

it("ignores a late answer from a previous workspace selection", async () => {
  fixture.selected = "workspace";
  let resolve!: (value: string) => void;
  fixture.list.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  fixture.current = false;
  await act(async () => resolve("removed"));
  expect(container.textContent).toContain("Private chat");
});

it.each(["available", "unknown"])(
  "keeps the selected workspace when status is %s",
  async (status) => {
    fixture.selected = "workspace";
    fixture.list.mockResolvedValue(status);
    await act(async () =>
      root.render(
        <WorkspaceAccessGuard>
          <p>Private chat</p>
        </WorkspaceAccessGuard>,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(container.textContent).toContain("Private chat");
  },
);

it("shows an error if the workspace picker could not open", async () => {
  fixture.check.mockResolvedValue(false);
  fixture.change.mockRejectedValue(new Error("unavailable"));
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
});

it("shows the reason after an inaccessible selection forced a reload", async () => {
  window.sessionStorage.setItem("orkbot:space-unavailable-notice", "1");
  await act(async () =>
    root.render(
      <WorkspaceAccessGuard>
        <p>Private chat</p>
      </WorkspaceAccessGuard>,
    ),
  );
  expect(container.textContent).not.toContain("Private chat");
  expect(container.textContent).toContain("Workspace unavailable");
  expect(window.sessionStorage.getItem("orkbot:space-unavailable-notice")).toBeNull();
});
