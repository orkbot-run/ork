// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Adapts the inherited preload.cjs compatibility interface to the new scoped Rust transport.

import type { NativeHttpBridge } from "@orkbot/client-transport/native-fetch";
import { createNativeFetch } from "@orkbot/client-transport/native-fetch";
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
  computer: boolean;
  label: string;
  transport?: boolean;
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
  subscribe<void>("pairing", () => {
    void call<void>("pairing.sync").catch(() => undefined);
  });
  const bridge: OrkDesktop = {
    accounts: {
      signIn: () => call("accounts.signIn"),
      ...(config.transport ? { signInToServer: () => call<void>("accounts.signInToServer") } : {}),
      session: () => call("accounts.session"),
      workspaceTarget: () => call("accounts.workspaceTarget"),
      logout: () => call("accounts.logout"),
      retryRevocations: () => call("accounts.retryRevocations"),
      ...(config.transport
        ? {}
        : {
            createServerLoginGrant: (request: { origin: string; challenge: string }) =>
              call<{ grant: string; expiresAt: number }>(
                "accounts.createServerLoginGrant",
                request,
              ),
            consumeServerInitializationSecret: () =>
              call<string | null>("accounts.consumeServerInitializationSecret"),
          }),
    },
    pairing: {
      sync: () => call("pairing.sync"),
      clear: () => call("pairing.clear"),
    },
    platform: config.platform,
    nativeWindowFrame: config.platform !== "darwin",
    ...(config.computer
      ? {
          computer: {
            managesHostChoice: true,
            requestAccess: () => call<boolean>("computer.requestAccess"),
            revokeAccess: () => call<void>("computer.revokeAccess"),
            onConfigure: (listener: () => void) => subscribe("computer", listener),
          },
        }
      : {}),
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
    server: { change: () => call("server.change"), remember: () => call("server.remember") },
    locale: { set: (locale) => call("locale.set", { locale }) },
    monitoring: { enabled: () => call("monitoring.enabled") },
    passkeys: { rpIds: () => call("passkeys.rpIds") },
    update: {
      state: () => call("update.state"),
      check: () => call("update.check"),
      download: () => call("update.download"),
      install: () => call("update.install"),
      setChannel: (channel) => call("update.setChannel", { channel }),
    },
    oauth: {
      ...(config.transport
        ? {
            capture: (url: string, expectedState: string) =>
              call<OrkDesktopOAuthCallback>("oauth.capture", {
                url,
                expected_state: expectedState,
              }),
          }
        : {}),
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
  if (config.transport) {
    const pending = new Set<string>();
    let retired = false;
    const http: NativeHttpBridge = {
      open: async (_session, _revision, id, input) => {
        pending.add(id);
        await call<void>("transport.open", { id, input });
      },
      start: (_session, _revision, id) => call("transport.start", { id }),
      write: (_session, _revision, id, bytes) => call("transport.write", { id, bytes }),
      finish: (_session, _revision, id) => call("transport.finish", { id }),
      head: (_session, _revision, id) => call("transport.head", { id }),
      read: async (_session, _revision, id) => {
        const bytes = await call<string | null>("transport.read", { id });
        if (bytes === null) pending.delete(id);
        return bytes;
      },
      cancel: async (_session, _revision, id) => {
        pending.delete(id);
        await call<void>("transport.cancel", { id });
      },
    };
    const nativeFetch = createNativeFetch(
      http,
      {
        session: document,
        revision: 1,
        origin: config.origin,
        current: () => !retired,
      },
      () => {
        // getRandomValues also exists on the oldest supported macOS WebView.
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6]! & 15) | 64;
        bytes[8] = (bytes[8]! & 63) | 128;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
    );
    const ordinary = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), config.origin);
      if (url.origin === config.origin && init?.body instanceof FormData) {
        const headers = new Headers(init.headers);
        headers.delete("content-type");
        // The WebView's standard Request encoder supplies the multipart boundary and a byte
        // stream. File data crosses IPC in bounded chunks instead of one materialized buffer.
        return nativeFetch(new Request(url, { ...init, headers }));
      }
      return url.origin === config.origin
        ? nativeFetch(input instanceof Request ? input : url, init)
        : ordinary(input, init);
    };
    window.addEventListener(
      "pagehide",
      () => {
        retired = true;
        for (const id of pending)
          void call<void>("transport.cancel", { id }).catch(() => undefined);
        pending.clear();
      },
      { once: true },
    );
  }
}
