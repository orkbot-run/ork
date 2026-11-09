// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { DesktopUpdateState, OrkDesktop } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopUpdateSection, DesktopUpdatesProvider } from "./DesktopUpdates";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let cleanup = () => {};
afterEach(() => {
  cleanup();
  delete window.orkbotDesktop;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const idle: DesktopUpdateState = {
  phase: "idle",
  currentVersion: "1.2.1",
  availableVersion: null,
  percent: null,
  message: null,
  checkedAt: null,
};

it("compiles each progress label through the production Lingui macro", () => {
  const source = readFileSync(new NodeURL("./DesktopUpdates.tsx", import.meta.url), "utf8");
  const transformed = execFileSync(
    process.execPath,
    [
      "-e",
      `const babel = require("@babel/core");
      const source = require("node:fs").readFileSync(0, "utf8");
      const result = babel.transformSync(source, {
        filename: "DesktopUpdates.tsx", configFile: false, babelrc: false,
        plugins: ["@lingui/babel-plugin-lingui-macro"],
        parserOpts: { plugins: ["typescript", "jsx"] },
      });
      process.stdout.write(result.code);`,
    ],
    { cwd: fileURLToPath(new NodeURL("../../", import.meta.url)), input: source, encoding: "utf8" },
  );
  for (const label of [
    "Checking for updates",
    "Preparing update",
    "Downloading update",
    "Installing update",
  ]) {
    expect(transformed).toContain(`message: "${label}\\u2026"`);
  }
});

async function render(update: OrkDesktop["update"]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.orkbotDesktop = { update } as OrkDesktop;
  const host = document.createElement("div");
  const root = createRoot(host);
  cleanup = () => act(() => root.unmount());
  await act(async () =>
    root.render(
      <DesktopUpdatesProvider>
        <DesktopUpdateSection />
      </DesktopUpdatesProvider>,
    ),
  );
  return host;
}

it("polls progress during a pending check and does not replace it with an older check result", async () => {
  vi.useFakeTimers();
  let current = idle;
  let finishCheck!: (value: DesktopUpdateState) => void;
  const host = await render({
    state: async () => current,
    check: () =>
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    download: async () => current,
    install: async () => current,
  });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
    "Checking for updates…",
  );
  expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  current = { ...idle, phase: "available", availableVersion: "1.2.2" };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
    "Preparing update…",
  );
  current = { ...current, phase: "downloading", percent: null };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
    "Downloading update…",
  );
  expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  current = { ...current, percent: 37 };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("37");
  await act(async () => finishCheck({ ...idle, phase: "error", message: "Old check failed" }));
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("37");
  expect(host.textContent).not.toContain("Old check failed");
  current = { ...current, phase: "ready", percent: null };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.textContent).toContain("Restart to update");
});

it("reports a failed check after polling its still-checking state", async () => {
  vi.useFakeTimers();
  let current = idle;
  let finishCheck!: (value: DesktopUpdateState) => void;
  const host = await render({
    state: async () => current,
    check: () =>
      new Promise((resolve) => {
        finishCheck = resolve;
      }),
    download: async () => current,
    install: async () => current,
  });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  current = { ...idle, phase: "checking" };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  await act(async () => finishCheck({ ...idle, phase: "error", message: "Check failed" }));
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.textContent).toContain("Check failed");
});

it("offers retry if the check bridge fails after reporting checking", async () => {
  vi.useFakeTimers();
  let current = idle;
  let failCheck!: (error: Error) => void;
  const host = await render({
    state: async () => current,
    check: () =>
      new Promise((_resolve, reject) => {
        failCheck = reject;
      }),
    download: async () => current,
    install: async () => current,
  });
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  current = { ...idle, phase: "checking" };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  await act(async () => failCheck(new Error("offline")));
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.textContent).toContain("Could not complete the update. Try again.");
  expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
  expect(host.querySelector<HTMLButtonElement>("button")?.textContent).toContain(
    "Check for updates",
  );
});

it("shows installation only while an install request is pending", async () => {
  let finishInstall!: (value: DesktopUpdateState) => void;
  const ready: DesktopUpdateState = { ...idle, phase: "ready", availableVersion: "1.2.2" };
  const host = await render({
    state: async () => ready,
    check: async () => ready,
    download: async () => ready,
    install: () =>
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
  });
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-label")).toBe(
    "Installing update…",
  );
  expect(host.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  await act(async () => finishInstall({ ...ready, message: "Installation cancelled" }));
  expect(host.querySelector('[role="progressbar"]')).toBeNull();
  expect(host.textContent).toContain("Installation cancelled");
});
