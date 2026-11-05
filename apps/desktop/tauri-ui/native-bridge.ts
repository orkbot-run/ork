// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapts the inherited preload.cjs compatibility interface to the new scoped Rust transport.

import type {
  DesktopMenuCommand,
  OrkDesktop,
  OrkDesktopOAuthCallback,
  OrkDesktopSpeechEvent,
} from "@orkbot/contracts";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

declare const config: {
  origin: string;
  proof: string;
  platform: string;
  speech: boolean;
  label: string;
};

if (
  window.top === window &&
  window.location.origin === config.origin &&
  ["https:", "http:"].includes(window.location.protocol) &&
  getCurrentWebview().label === config.label
) {
  const document = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // Keep both proofs in this closure, outside the DOM and the public bridge.
  const request = <T>(command: Record<string, unknown>) =>
    invoke<T>("native_command", { proof: config.proof, document, command });
  const ready = request<void>({ type: "hello", epoch: Math.round(performance.timeOrigin * 1000) });
  // A denied popup must not create an unhandled rejection during its first paint.
  void ready.catch(() => {});
  const call = <T>(type: string, args: Record<string, unknown> = {}) =>
    ready.then(() => request<T>({ type, ...args }));
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const subscribe = <T>(kind: string, listener: (payload: T) => void) => {
    const subscribers = listeners.get(kind) ?? new Set();
    listeners.set(kind, subscribers);
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  };
  Object.defineProperty(window, "__orkbotNativeDispatch", {
    value: (targetDocument: string, kind: string, payload: never) => {
      // Check before delivery, including when native evaluation was queued across a reload.
      if (targetDocument !== document) return;
      for (const listener of listeners.get(kind) ?? []) {
        try {
          listener(payload);
        } catch {
          /* One subscriber cannot prevent another's cleanup. */
        }
      }
    },
    configurable: false,
    writable: false,
  });
  const bridge: OrkDesktop = {
    platform: config.platform,
    nativeWindowFrame: config.platform !== "darwin",
    badge: { set: (count) => call<boolean>("badge.set", { count }) },
    window: {
      close: () => call("window.close"),
      minimize: () => call("window.minimize"),
      toggleMaximize: () => call("window.toggleMaximize"),
      state: () => call("window.state"),
    },
    menu: {
      onCommand: (listener) => subscribe<DesktopMenuCommand>("menu", listener),
    },
    settings: { onOpen: (listener) => subscribe("settings", listener) },
    server: { change: () => call("server.change") },
    locale: { set: (locale) => call("locale.set", { locale }) },
    monitoring: { enabled: () => call("monitoring.enabled") },
    passkeys: { rpIds: () => call("passkeys.rpIds") },
    update: {
      state: () => call("update.state"),
      check: () => call("update.check"),
      download: () => call("update.download"),
      install: () => call("update.install"),
    },
    oauth: {
      open: (url) => call("oauth.open", { url }),
      cancel: (url) => call("oauth.cancel", { url }),
      onCallback: (listener) => subscribe<OrkDesktopOAuthCallback>("oauth", listener),
    },
    ...(config.speech
      ? {
          speech: {
            start: (language: string, session: number) =>
              call<boolean>("speech.start", { language, session }),
            stop: (session: number) => call<void>("speech.stop", { session }),
            abort: (session: number) => call<void>("speech.abort", { session }),
            onEvent: (listener: (event: OrkDesktopSpeechEvent) => void) =>
              subscribe<OrkDesktopSpeechEvent>("speech", listener),
          },
        }
      : {}),
  };
  for (const value of Object.values(bridge)) {
    if (typeof value === "object" && value !== null) Object.freeze(value);
  }
  Object.defineProperty(window, "orkbotDesktop", {
    value: Object.freeze(bridge),
    configurable: false,
    writable: false,
  });
}
