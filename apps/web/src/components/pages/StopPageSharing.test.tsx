// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PageVisibility } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StopPageSharing } from "./StopPageSharing";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("hides access controls on private pages and only revokes existing or uncertain links", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const stop = vi.fn();
  const show = (visibility: PageVisibility | null, pending = false, error: string | null = null) =>
    act(async () =>
      root.render(
        <StopPageSharing visibility={visibility} pending={pending} error={error} onStop={stop} />,
      ),
    );

  await show("private");
  expect(document.querySelector("button")).toBeNull();
  for (const visibility of ["link", null] as const) {
    await show(visibility);
    expect(document.querySelector("button")?.textContent).toBe("Stop sharing");
    await act(async () => document.querySelector("button")!.click());
  }
  expect(stop).toHaveBeenCalledTimes(2);
  await show(null, true);
  expect(document.querySelector("button")?.disabled).toBe(true);
  await act(async () => document.querySelector("button")!.click());
  expect(stop).toHaveBeenCalledTimes(2);

  await show(null, false, "Could not change access.");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not change access.");
  expect(document.querySelector("a")).toBeNull();
  expect(document.querySelector('[role="radio"]')).toBeNull();
  await act(async () => root.unmount());
});
