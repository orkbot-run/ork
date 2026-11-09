// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateProgress } from "./UpdateProgress";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("announces stages and exposes percentages only when the native updater supplies them", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  cleanup = () => act(() => root.unmount());
  const render = async (label: string, percent: number | null) => {
    await act(async () => root.render(<UpdateProgress label={label} percent={percent} />));
    return host.querySelector('[role="progressbar"]')!;
  };
  let bar = await render("Downloading update…", null);
  expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(bar.getAttribute("aria-label")).toBe("Downloading update…");
  expect(host.textContent).not.toContain("%");
  expect(
    host.querySelector('[data-slot="progress-indicator"]')?.hasAttribute("data-indeterminate"),
  ).toBe(true);

  bar = await render("Downloading update…", 42);
  expect(bar.getAttribute("aria-valuenow")).toBe("42");
  expect(host.textContent).toContain("42%");

  bar = await render("Installing update…", null);
  expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Installing update…");
  expect(host.textContent).not.toContain("42%");
});
