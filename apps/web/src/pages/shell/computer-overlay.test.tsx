// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@orkbot/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: () => null }));
vi.mock("../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: () => null,
  TeachStopButton: () => null,
}));

import { ComputerOverlay } from "./computer-overlay";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada", color: "ink", status: "idle" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
    capabilities: { start: true, screen: true, control: true, terminal: false },
  };
}

async function render(
  state: ComputerStatus["state"],
  onStart = vi.fn(),
  props: Partial<ComponentProps<typeof ComputerOverlay>> = {},
) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={computer(state)}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
        onRefreshComputer={async () => undefined}
        onClose={() => undefined}
        {...props}
      />,
    );
  });
  return onStart;
}

function startButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers Start for a stopped computer instead of a bare label", async () => {
  const onStart = await render("stopped");
  expect(container.textContent).toContain("Computer is stopped");
  await act(async () => startButton()?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("offers Start for an asleep computer", async () => {
  await render("suspended");
  expect(container.textContent).toContain("Computer is asleep");
  expect(startButton()).toBeDefined();
});

it("keeps ordinary control unavailable on an older server without an explicit capability", async () => {
  const status = computer("running");
  delete status.capabilities;
  status.screenAvailable = true;
  await render("running", vi.fn(), { computer: status });
  expect(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Take control",
    ),
  ).toBe(false);
});

it("retains Release after control capability is withdrawn", async () => {
  const onRelease = vi.fn(async () => undefined);
  await render("running", vi.fn(), {
    hasControl: true,
    onRelease,
    computer: {
      ...computer("running"),
      controlHolder: "user",
      capabilities: { start: false, screen: false, control: false, terminal: false },
    },
  });
  const release = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Release control",
  );
  expect(release).toBeDefined();
  await act(async () => release?.click());
  expect(onRelease).toHaveBeenCalledOnce();
});

it("disables Start for an explicitly disabled target without inferring from kind", async () => {
  const onStart = vi.fn();
  await render("stopped", onStart, {
    computer: {
      ...computer("stopped"),
      capabilities: { start: false, screen: true, control: true, terminal: false },
    },
  });
  expect(startButton()?.disabled).toBe(true);
  await act(async () => startButton()?.click());
  expect(onStart).not.toHaveBeenCalled();
});
