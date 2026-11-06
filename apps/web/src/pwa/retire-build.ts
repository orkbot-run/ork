// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Plugin } from "vite";
import { LEGACY_BROWSER_CACHE_PREFIX } from "./retire.js";

/** A classic worker replaces old installations without retaining an offline product shell. */
export function browserShellRetirementSource(): string {
  return `self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(${JSON.stringify(LEGACY_BROWSER_CACHE_PREFIX)})).map(name => caches.delete(name)));
  await self.clients.claim();
  await self.registration.unregister();
})()));`;
}

export function browserShellRetirement(): Plugin {
  return {
    name: "orkbot-browser-shell-retirement",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/sw.js") return next();
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(browserShellRetirementSource());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "sw.js", source: browserShellRetirementSource() });
    },
  };
}
