// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom

import type { Routine } from "@orkbot/contracts";
import type * as UiWeb from "@orkbot/ui-web";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ i18n: { locale: "en" }, t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@orkbot/ui-web", async (original) => ({
  ...(await original<typeof UiWeb>()),
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { RoutineList } from "./RoutineEditor";

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("keeps the routine row's stop scope accurate (all: %s)", (stopAll) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onStop = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const routine = {
    id: "routine-1",
    name: "Morning report",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    watch: null,
    modelProvider: null,
    modelId: null,
  } as Routine;
  try {
    act(() =>
      root.render(
        <RoutineList
          routines={[routine]}
          runningRoutineId={routine.id}
          stopAll={stopAll}
          onCreate={() => {}}
          onEdit={() => {}}
          onStop={onStop}
        />,
      ),
    );
    const stop = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Stop"),
    );
    expect(stop?.textContent).toBe(stopAll ? "Stop all" : "Stop");
    act(() => stop?.click());
    expect(onStop).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});
