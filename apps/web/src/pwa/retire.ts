// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// Compatibility identifier used by previously installed browser shells.
export const LEGACY_BROWSER_CACHE_PREFIX = "orkbot-shell-";

/** Remove only this product's previous browser installation, leaving other origin apps alone. */
export async function retireBrowserShell(target: Window = window): Promise<void> {
  if (!("serviceWorker" in target.navigator)) return;
  try {
    const registrations = await target.navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const script =
        registration.active?.scriptURL ??
        registration.waiting?.scriptURL ??
        registration.installing?.scriptURL;
      if (
        !script ||
        script !== new URL("/sw.js", target.location.origin).href ||
        registration.scope !== `${target.location.origin}/`
      )
        continue;
      await registration.unregister();
    }
    if ("caches" in target) {
      const names = await target.caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(LEGACY_BROWSER_CACHE_PREFIX))
          .map((name) => target.caches.delete(name)),
      );
    }
  } catch {
    // Browser storage restrictions must not prevent opening the native application.
  }
}
