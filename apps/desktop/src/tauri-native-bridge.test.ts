// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import path from "node:path";
import vm from "node:vm";
import type { OrkDesktop, OrkDesktopSpeechEvent } from "@orkbot/contracts";
import { build } from "esbuild";
import { beforeAll, describe, expect, it, vi } from "vitest";

type NativeRequest = {
  proof: string;
  document: string;
  command: { type: string; [key: string]: unknown };
};
type NativeInvoke = (command: string, request: NativeRequest) => Promise<unknown>;

class TestWindow extends EventTarget {
  readonly location: { origin: string; protocol: string };
  readonly top: TestWindow | object;
  declare orkbotDesktop?: OrkDesktop;
  declare __orkbotNativeDispatch?: (document: string, kind: string, payload: unknown) => void;

  constructor(origin: string, protocol: string, topLevel: boolean) {
    super();
    this.location = { origin, protocol };
    this.top = topLevel ? this : {};
  }
}

let bundledBridge = "";

beforeAll(async () => {
  const output = await build({
    entryPoints: [path.join(import.meta.dirname, "../tauri-ui/native-bridge.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    target: "es2022",
    plugins: [
      {
        name: "native-invoke-fixture",
        setup(plugin) {
          plugin.onResolve({ filter: /^@tauri-apps\/api\/(core|webview)$/ }, (args) => ({
            path: args.path,
            namespace: "native-invoke-fixture",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "native-invoke-fixture" }, (args) => ({
            contents:
              args.path === "@tauri-apps/api/core"
                ? "export const invoke = (...args) => globalThis.__nativeInvoke(...args);"
                : "export const getCurrentWebview = () => ({ label: globalThis.__nativeWebviewLabel });",
            loader: "js",
          }));
        },
      },
    ],
  });
  const file = output.outputFiles[0];
  if (!file) throw new Error("The native bridge bundle was not produced");
  bundledBridge = file.text;
});

function runBridge(
  options: {
    origin?: string;
    currentOrigin?: string;
    protocol?: string;
    currentLabel?: string;
    topLevel?: boolean;
    platform?: string;
    speech?: boolean;
    computer?: boolean;
    randomByte?: number;
    timeOrigin?: number;
    invoke?: NativeInvoke;
  } = {},
) {
  const origin = options.origin ?? "https://app.example.com";
  const config = {
    origin,
    label: "server-1",
    proof: "fixture-native-proof",
    platform: options.platform ?? "darwin",
    speech: options.speech ?? false,
    computer: options.computer ?? false,
  };
  const currentOrigin = options.currentOrigin ?? origin;
  const window = new TestWindow(
    currentOrigin,
    options.protocol ?? new URL(currentOrigin).protocol,
    options.topLevel ?? true,
  );
  const invoke = vi.fn<NativeInvoke>((command, request) =>
    options.invoke ? options.invoke(command, request) : Promise.resolve(undefined),
  );
  const random = vi.fn((bytes: Uint8Array) => bytes.fill(options.randomByte ?? 11));
  const timeOrigin = options.timeOrigin ?? 1_700_000_000_000.125;
  const context = vm.createContext({
    window,
    crypto: { getRandomValues: random },
    performance: { timeOrigin },
    __nativeInvoke: invoke,
    __nativeWebviewLabel: options.currentLabel ?? config.label,
  });
  const evaluate = (source: string) =>
    vm.runInContext(source, context, { filename: "tauri-native-bridge-fixture.js" }) as unknown;
  evaluate(`(() => { const config = ${JSON.stringify(config)};\n${bundledBridge}\n})();`);

  const documentId = () => {
    const hello = invoke.mock.calls.find(([, request]) => request.command.type === "hello");
    if (!hello) throw new Error("No native hello request was sent");
    return hello[1].document;
  };
  const signal = (kind: string, payload?: unknown, document = documentId()) => {
    const dispatch = window.__orkbotNativeDispatch;
    if (!dispatch) throw new Error("The native event dispatcher is unavailable");
    dispatch(document, kind, payload);
  };

  return {
    window,
    invoke,
    random,
    documentId,
    signal,
    evaluate,
    config,
    helloEpoch: Math.round(timeOrigin * 1000),
  };
}

function desktop(window: TestWindow): OrkDesktop {
  if (!window.orkbotDesktop) throw new Error("The desktop bridge is unavailable");
  return window.orkbotDesktop;
}

/** The Rust event generator tests enforce this literal-argument and live-origin contract. */
function nativeEventLiteral(origin: string, document: string, kind: string, payload: unknown) {
  return `if (window.location.origin === ${JSON.stringify(origin)} &&
    (window.location.protocol === 'https:' || window.location.protocol === 'http:')) {
    window.__orkbotNativeDispatch?.(${JSON.stringify(document)}, ${JSON.stringify(kind)}, ${JSON.stringify(payload)});
  }`;
}

describe("Tauri native bridge", () => {
  it.each([
    { topLevel: false },
    { currentOrigin: "https://app.example.com.evil" },
    { currentOrigin: "https://app.example.com:444" },
    { currentOrigin: "http://app.example.com" },
    { currentLabel: "auth-server-1" },
    { currentLabel: "setup" },
    { protocol: "blob:" },
  ])("refuses a subframe or another exact origin: %j", (options) => {
    const { window, invoke, random } = runBridge(options);
    expect(window.orkbotDesktop).toBeUndefined();
    expect(window.__orkbotNativeDispatch).toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32", "linux"])(
    "freezes the public bridge and keeps proofs out of its properties on %s",
    (platform) => {
      const { window, config, documentId, random } = runBridge({ platform });
      const bridge = desktop(window);
      expect(bridge.platform).toBe(platform);
      expect(bridge.nativeWindowFrame).toBe(platform !== "darwin");
      expect(Object.isFrozen(bridge)).toBe(true);
      for (const value of Object.values(bridge)) {
        if (typeof value === "object" && value !== null) expect(Object.isFrozen(value)).toBe(true);
      }
      expect(Object.getOwnPropertyDescriptor(window, "orkbotDesktop")).toMatchObject({
        configurable: false,
        writable: false,
      });
      expect(Object.getOwnPropertyDescriptor(window, "__orkbotNativeDispatch")).toMatchObject({
        configurable: false,
        writable: false,
      });
      for (const privateName of ["proof", "document", "config", "invoke", "request"]) {
        expect(Reflect.ownKeys(bridge)).not.toContain(privateName);
      }
      expect(JSON.stringify(bridge)).not.toContain(config.proof);
      expect(JSON.stringify(bridge)).not.toContain(documentId());
      expect(documentId()).toBe("0b".repeat(32));
      expect(random).toHaveBeenCalledTimes(1);
      expect(random.mock.calls[0]?.[0]).toHaveLength(32);
    },
  );

  it("waits for hello before dispatching any public command", async () => {
    let acceptHello = () => {};
    const hello = new Promise<void>((resolve) => {
      acceptHello = resolve;
    });
    const { window, invoke } = runBridge({
      invoke: (_name, request) =>
        request.command.type === "hello" ? hello : Promise.resolve("window-state"),
    });
    const result = desktop(window).window.state();
    await Promise.resolve();
    expect(invoke.mock.calls.map(([, request]) => request.command.type)).toEqual(["hello"]);
    acceptHello();
    await expect(result).resolves.toBe("window-state");
    expect(invoke.mock.calls.map(([, request]) => request.command.type)).toEqual([
      "hello",
      "window.state",
    ]);
  });

  it("syncs pairing after native activation once the document handshake succeeds", async () => {
    let acceptHello = () => {};
    const hello = new Promise<void>((resolve) => {
      acceptHello = resolve;
    });
    const { invoke, signal } = runBridge({
      invoke: (_name, request) => (request.command.type === "hello" ? hello : Promise.resolve()),
    });
    signal("pairing", null);
    await Promise.resolve();
    expect(invoke.mock.calls.map(([, request]) => request.command.type)).toEqual(["hello"]);
    acceptHello();
    await vi.waitFor(() =>
      expect(invoke.mock.calls.map(([, request]) => request.command)).toEqual([
        expect.objectContaining({ type: "hello" }),
        { type: "pairing.sync" },
      ]),
    );
  });

  it("contains native activation pairing failures", async () => {
    const { invoke, signal } = runBridge({
      invoke: (_name, request) =>
        request.command.type === "hello"
          ? Promise.resolve()
          : Promise.reject(new Error("Secure storage unavailable")),
    });
    signal("pairing", null);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });

  it("propagates a refused hello without sending later commands", async () => {
    const { window, invoke } = runBridge({
      invoke: () => Promise.reject(new Error("Native document refused")),
    });
    await expect(desktop(window).window.state()).rejects.toThrow("Native document refused");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("routes typed commands with their arguments and the private document proofs", async () => {
    const { window, invoke, config, documentId, helloEpoch } = runBridge({ speech: true });
    const bridge = desktop(window);
    await bridge.accounts?.signIn();
    await bridge.accounts?.session();
    await bridge.accounts?.logout();
    await bridge.pairing?.sync();
    await bridge.pairing?.clear();
    await bridge.badge?.set(7);
    await bridge.locale?.set("es-CL");
    await bridge.oauth.open?.("https://identity.example.com/authorize");
    await bridge.oauth.cancel?.("https://identity.example.com/authorize");
    await bridge.window.close();
    await bridge.window.minimize();
    await bridge.window.toggleMaximize();
    await bridge.window.state();
    await bridge.server?.change();
    await bridge.server?.remember?.();
    await bridge.monitoring?.enabled();
    await bridge.passkeys?.rpIds();
    await bridge.update.state();
    await bridge.update.check();
    await bridge.update.download();
    await bridge.update.install();
    await bridge.speech?.start("en-US", 4);
    await bridge.speech?.stop(4);
    await bridge.speech?.abort(4);
    expect(invoke.mock.calls.map(([, request]) => request.command)).toEqual([
      { type: "hello", epoch: helloEpoch },
      { type: "accounts.signIn" },
      { type: "accounts.session" },
      { type: "accounts.logout" },
      { type: "pairing.sync" },
      { type: "pairing.clear" },
      { type: "badge.set", count: 7 },
      { type: "locale.set", locale: "es-CL" },
      { type: "oauth.open", url: "https://identity.example.com/authorize" },
      { type: "oauth.cancel", url: "https://identity.example.com/authorize" },
      { type: "window.close" },
      { type: "window.minimize" },
      { type: "window.toggleMaximize" },
      { type: "window.state" },
      { type: "server.change" },
      { type: "server.remember" },
      { type: "monitoring.enabled" },
      { type: "passkeys.rpIds" },
      { type: "update.state" },
      { type: "update.check" },
      { type: "update.download" },
      { type: "update.install" },
      { type: "speech.start", language: "en-US", session: 4 },
      { type: "speech.stop", session: 4 },
      { type: "speech.abort", session: 4 },
    ]);
    for (const [command, request] of invoke.mock.calls) {
      expect(command).toBe("native_command");
      expect(request.proof).toBe(config.proof);
      expect(request.document).toBe(documentId());
      expect(Reflect.ownKeys(request).sort()).toEqual(["command", "document", "proof"]);
    }
  });

  it("exposes only consent controls for an app-managed server", async () => {
    expect(desktop(runBridge().window).computer).toBeUndefined();
    const harness = runBridge({ computer: true });
    const computer = desktop(harness.window).computer;
    expect(computer?.managesHostChoice).toBe(true);
    await computer?.requestAccess();
    await computer?.revokeAccess();
    expect(harness.invoke.mock.calls.slice(1).map(([, request]) => request.command)).toEqual([
      { type: "computer.requestAccess" },
      { type: "computer.revokeAccess" },
    ]);
    const configure = vi.fn();
    const unsubscribe = computer?.onConfigure(configure);
    harness.signal("computer", undefined, "stale-document");
    expect(configure).not.toHaveBeenCalled();
    harness.signal("computer");
    expect(configure).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    harness.signal("computer");
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it("ignores stale document events even when the session number matches", () => {
    const previous = runBridge({ randomByte: 1, speech: true });
    const current = runBridge({ randomByte: 2, speech: true });
    const received = vi.fn();
    const rawDomListener = vi.fn();
    current.window.addEventListener("orkbot:native", rawDomListener);
    desktop(current.window).speech?.onEvent(received);
    const payload: OrkDesktopSpeechEvent = { type: "result", session: 1, text: "current" };
    expect(previous.documentId()).not.toBe(current.documentId());
    current.signal("speech", payload, previous.documentId());
    current.signal("oauth", payload);
    expect(received).not.toHaveBeenCalled();
    expect(rawDomListener).not.toHaveBeenCalled();
    current.signal("speech", payload);
    expect(received).toHaveBeenCalledExactlyOnceWith(payload);
    expect(rawDomListener).not.toHaveBeenCalled();
  });

  it("isolates a failing subscriber without exposing event payloads through the DOM", () => {
    const harness = runBridge();
    const bridge = desktop(harness.window);
    const received = vi.fn();
    const rawDomListener = vi.fn();
    harness.window.addEventListener("orkbot:native", rawDomListener);
    bridge.menu?.onCommand(() => {
      throw new Error("Subscriber failed");
    });
    const unsubscribe = bridge.menu?.onCommand(received);
    expect(() => harness.signal("menu", "new")).not.toThrow();
    expect(received).toHaveBeenCalledExactlyOnceWith("new");
    expect(rawDomListener).not.toHaveBeenCalled();
    unsubscribe?.();
    harness.signal("menu", "new");
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("does not expose a rejected stale payload to a page-controlled array iterator", () => {
    const harness = runBridge({ speech: true });
    const received = vi.fn();
    desktop(harness.window).speech?.onEvent(received);
    harness.evaluate(`
      globalThis.intercepted = [];
      Array.prototype[Symbol.iterator] = function* () {
        for (let i = 0; i < this.length; i++) {
          intercepted.push(this[i]);
          yield this[i];
        }
      };
    `);
    harness.evaluate(
      nativeEventLiteral(harness.config.origin, "previous-document", "speech", {
        type: "result",
        session: 1,
        text: "fixture-private",
      }),
    );
    expect(received).not.toHaveBeenCalled();
    expect(harness.evaluate("intercepted.length")).toBe(0);
  });

  it.each([{ currentOrigin: "https://foreign.example.com" }, { protocol: "blob:" }])(
    "rejects native delivery after foreign or blob navigation: %j",
    (options) => {
      const harness = runBridge(options);
      const intercept = vi.fn();
      Object.defineProperty(harness.window, "__orkbotNativeDispatch", { value: intercept });
      harness.evaluate(
        nativeEventLiteral(harness.config.origin, "previous-document", "speech", {
          type: "result",
          session: 1,
          text: "fixture-private",
        }),
      );
      expect(intercept).not.toHaveBeenCalled();
    },
  );

  it("forwards only each subscription payload and removes listeners when unsubscribed", () => {
    const harness = runBridge({ speech: true });
    const bridge = desktop(harness.window);
    const menu = vi.fn();
    const settings = vi.fn();
    const oauth = vi.fn();
    const speech = vi.fn();
    const unsubscribe = [
      bridge.menu?.onCommand(menu),
      bridge.settings?.onOpen(settings),
      bridge.oauth.onCallback(oauth),
      bridge.speech?.onEvent(speech),
    ];
    const callback = { code: "fixture-code", state: "fixture-state" };
    const spoken: OrkDesktopSpeechEvent = { type: "end", session: 3 };
    harness.signal("menu", "new");
    harness.signal("settings");
    harness.signal("oauth", callback);
    harness.signal("speech", spoken);
    expect(menu).toHaveBeenCalledExactlyOnceWith("new");
    expect(settings).toHaveBeenCalledTimes(1);
    expect(oauth).toHaveBeenCalledExactlyOnceWith(callback);
    expect(speech).toHaveBeenCalledExactlyOnceWith(spoken);
    for (const remove of unsubscribe) {
      remove?.();
      remove?.();
    }
    harness.signal("menu", "new");
    harness.signal("settings");
    harness.signal("oauth", callback);
    harness.signal("speech", spoken);
    expect(menu).toHaveBeenCalledTimes(1);
    expect(settings).toHaveBeenCalledTimes(1);
    expect(oauth).toHaveBeenCalledTimes(1);
    expect(speech).toHaveBeenCalledTimes(1);
  });

  it.each(["darwin", "win32", "linux"])(
    "omits unsupported system speech entirely on %s",
    (platform) => {
      const bridge = desktop(runBridge({ platform, speech: false }).window);
      expect(bridge.speech).toBeUndefined();
      expect(Object.hasOwn(bridge, "speech")).toBe(false);
    },
  );
});
