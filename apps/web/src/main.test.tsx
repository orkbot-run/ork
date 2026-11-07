// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// @vitest-environment jsdom

import type { OrkDesktop } from "@orkbot/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { render, retire, connect, callback } = vi.hoisted(() => ({
  render: vi.fn(),
  retire: vi.fn(async () => {}),
  connect: () => null,
  callback: () => null,
}));

vi.mock("react-dom/client", () => ({ createRoot: () => ({ render }) }));
vi.mock("./pwa/retire", () => ({ retireBrowserShell: retire }));
vi.mock("./browser-connect", () => ({ BrowserConnect: connect }));
vi.mock("./browser-callbacks", () => ({ BrowserCallbacks: callback }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  delete window.orkbotDesktop;
  delete window.orkbotBundledRenderer;
  document.body.innerHTML = "";
});

it("leaves the root to the renderer shipped by a current desktop application", async () => {
  window.orkbotDesktop = {} as OrkDesktop;
  window.orkbotBundledRenderer = true;
  await import("./main");
  expect(render).not.toHaveBeenCalled();
  expect(retire).not.toHaveBeenCalled();
});

it("gives an older desktop an update surface instead of an empty product window", async () => {
  window.orkbotDesktop = {} as OrkDesktop;
  await import("./main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect(render.mock.calls[0]?.[0].type.name).toBe("BrowserNativeUpdate");
  expect(retire).not.toHaveBeenCalled();
});

it("serves only the connection handoff for a browser product URL", async () => {
  window.history.replaceState(null, "", "/app");
  await import("./main");
  await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
  expect(render.mock.calls[0]?.[0].type).toBe(connect);
  expect(retire).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "keeps protocol callbacks available with native bridge %s",
  async (native) => {
    if (native) window.orkbotDesktop = {} as OrkDesktop;
    window.history.replaceState(null, "", "/sso/callback");
    await import("./main");
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(render.mock.calls[0]?.[0].type).toBe(callback);
    expect(retire).toHaveBeenCalledOnce();
  },
);
