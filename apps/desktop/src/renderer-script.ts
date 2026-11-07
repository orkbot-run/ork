// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Run packaged code on the selected server origin without changing its cookie or API scope. */
export function packagedRendererScript(javascript: string, css: string): string {
  return `(() => {
  if (window.top !== window || window.location.origin !== config.origin ||
      !["https:", "http:"].includes(window.location.protocol) || !window.orkbotDesktop) return;
  const pathname = window.location.pathname;
  const application = ["/", "/sign-in", "/sign-up", "/forgot-password", "/reset-password",
    "/integrations/setup", "/admin/access", "/admin/plugins"].includes(pathname) ||
    ["/app", "/onboarding"].some(path => pathname === path || pathname.startsWith(path + "/"));
  if (!application || window.orkbotBundledRenderer) return;
  Object.defineProperty(window, "orkbotBundledRenderer", {
    value: true, writable: false, configurable: false
  });
  const start = () => {
    // An API can update before its web container. Older HTML still runs its own renderer.
    if (document.querySelector('meta[name="orkbot-native-renderer"]')?.getAttribute("content") !== "bundled-v1") return;
    const root = document.getElementById("root");
    if (!root) throw new Error("The server did not provide an application document.");
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    if (config.platform === "darwin") document.documentElement.dataset.os = "mac";
    ${javascript}
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();`;
}
