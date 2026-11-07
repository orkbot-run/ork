// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { packagedRendererScript } from "./renderer-script.js";

function renderer(
  options: {
    origin?: string;
    protocol?: string;
    pathname?: string;
    topLevel?: boolean;
    bridge?: boolean;
    ready?: boolean;
    rendererProtocol?: string | null;
  } = {},
) {
  const styles: { textContent?: string }[] = [];
  const listeners: (() => void)[] = [];
  const window = {
    location: {
      origin: options.origin ?? "https://server.example.test",
      protocol: options.protocol ?? "https:",
      pathname: options.pathname ?? "/app",
    },
    top: {} as object,
    ...(options.bridge === false ? {} : { orkbotDesktop: Object.freeze({}) }),
  };
  if (options.topLevel !== false) window.top = window;
  const context = vm.createContext({
    window,
    boots: 0,
    config: { origin: "https://server.example.test", platform: "darwin" },
    document: {
      readyState: options.ready ? "complete" : "loading",
      getElementById: () => ({}),
      querySelector: () =>
        options.rendererProtocol === null
          ? null
          : {
              getAttribute: () => options.rendererProtocol ?? "bundled-v1",
            },
      createElement: () => ({}),
      head: { appendChild: (style: { textContent?: string }) => styles.push(style) },
      documentElement: { dataset: {} },
      addEventListener: (_event: string, callback: () => void) => listeners.push(callback),
    },
  });
  const script = packagedRendererScript("globalThis.boots += 1;", ":root { color: black; }");
  const run = () => vm.runInContext(script, context);
  run();
  return { context, window, styles, listeners, run };
}

describe("packaged desktop renderer", () => {
  it.each([
    { topLevel: false },
    { origin: "https://server.example.test.evil" },
    { origin: "https://server.example.test:444" },
    { protocol: "blob:" },
    { bridge: false },
  ])("does not execute or expose a marker outside the scoped native document: %j", (options) => {
    const result = renderer(options);
    expect(Reflect.has(result.window, "orkbotBundledRenderer")).toBe(false);
    expect(result.listeners).toHaveLength(0);
    expect(result.styles).toHaveLength(0);
    expect(result.context.boots).toBe(0);
  });

  it.each([
    "/sso/callback",
    "/integrations/callback",
    "/mcp/oauth/callback",
    "/messaging/slack/callback",
    "/callback",
    "/api/auth/callback/oidc",
    "/rpc/health",
    "/novnc/vnc.html",
    "/computer-screen/screen.html",
    "/html-viewer.html",
    "/api/v1/assets/page-runtime.js",
    "/app.html",
    "/application",
    "/p/shared-token",
  ])("leaves protocol, embedded and non-product documents alone: %s", (pathname) => {
    const result = renderer({ pathname });
    expect(Reflect.has(result.window, "orkbotBundledRenderer")).toBe(false);
    expect(result.listeners).toHaveLength(0);
  });

  it.each([
    "/",
    "/app",
    "/app/bot",
    "/onboarding",
    "/onboarding/models",
    "/sign-in",
    "/admin/access",
    "/integrations/setup",
  ])("mounts packaged code and CSS after the application document is ready: %s", (pathname) => {
    const result = renderer({ pathname });
    expect(Object.getOwnPropertyDescriptor(result.window, "orkbotBundledRenderer")).toMatchObject({
      value: true,
      writable: false,
      configurable: false,
    });
    expect(result.context.boots).toBe(0);
    expect(result.styles).toHaveLength(0);
    result.listeners[0]!();
    expect(result.context.boots).toBe(1);
    expect(result.styles).toEqual([{ textContent: ":root { color: black; }" }]);
    expect(result.context.document.documentElement.dataset.os).toBe("mac");
    result.run();
    expect(result.listeners).toHaveLength(1);
    expect(result.context.boots).toBe(1);
  });

  it("starts immediately on an already parsed document without fetching code or creating scripts", () => {
    const result = renderer({ ready: true });
    expect(result.context.boots).toBe(1);
    expect(result.listeners).toHaveLength(0);
    expect(result.styles).toHaveLength(1);
  });

  it.each([null, "bundled-v2"])(
    "leaves an older web document's own renderer intact: %s",
    (rendererProtocol) => {
      const result = renderer({ ready: true, rendererProtocol });
      expect(result.context.boots).toBe(0);
      expect(result.styles).toHaveLength(0);
    },
  );
});
