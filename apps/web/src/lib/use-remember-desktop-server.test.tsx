// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRememberDesktopServer } from "./use-remember-desktop-server";

const mocks = vi.hoisted(() => ({ remember: vi.fn(), error: vi.fn(), dismiss: vi.fn() }));
vi.mock("./desktop", () => ({ desktopBridge: () => ({ server: { remember: mocks.remember } }) }));
vi.mock("@orkbot/ui-web", () => ({ toast: { error: mocks.error, dismiss: mocks.dismiss } }));
let root: ReturnType<typeof createRoot>;
function Probe({ session }: { session: string | null }) {
  useRememberDesktopServer(session);
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.remember.mockResolvedValue(undefined);
  mocks.error.mockReturnValue("notice");
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("waits for authentication and saves once per settled session", async () => {
  await act(async () => root.render(<Probe session={null} />));
  expect(mocks.remember).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe session="session-1" />));
  await act(async () => root.render(<Probe session="session-1" />));
  expect(mocks.remember).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Probe session="session-2" />));
  expect(mocks.remember).toHaveBeenCalledTimes(2);
});

it("offers retry after failure and clears the notice after a successful save", async () => {
  mocks.remember.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<Probe session="session-1" />));
  expect(mocks.error).toHaveBeenCalledOnce();
  await act(async () => mocks.error.mock.calls[0]![1].action.onClick());
  expect(mocks.remember).toHaveBeenCalledTimes(2);
  expect(mocks.dismiss).toHaveBeenCalledWith("notice");
});

it("retries on connectivity recovery, but never retries an old account", async () => {
  mocks.remember.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(<Probe session="session-1" />));
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(mocks.remember).toHaveBeenCalledTimes(2);
  const retry = mocks.error.mock.calls[0]![1].action.onClick;
  await act(async () => root.render(<Probe session={null} />));
  await act(async () => retry());
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(mocks.remember).toHaveBeenCalledTimes(2);
});

it("does not show a stale failure after sign-out", async () => {
  let reject!: (error: Error) => void;
  mocks.remember.mockReturnValueOnce(
    new Promise((_, failure) => {
      reject = failure;
    }),
  );
  await act(async () => root.render(<Probe session="session-1" />));
  await act(async () => root.render(<Probe session={null} />));
  await act(async () => reject(new Error("late")));
  expect(mocks.error).not.toHaveBeenCalled();
});
