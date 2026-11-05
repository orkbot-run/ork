// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Modified for the Tauri desktop path. Inherited material remains Apache-2.0.

type ServiceWorkerHost = Pick<Window, "addEventListener" | "navigator" | "orkbotDesktop">;

/**
 * Production browsers only. Dev must always reach Vite, and the desktop app serves the
 * renderer itself, so a worker there would shadow the bundled assets.
 */
export function registerServiceWorker(
  target: ServiceWorkerHost = window,
  production: boolean = import.meta.env.PROD,
): void {
  if (!production || target.orkbotDesktop || !("serviceWorker" in target.navigator)) return;
  target.addEventListener(
    "load",
    () => {
      target.navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    },
    { once: true },
  );
}
