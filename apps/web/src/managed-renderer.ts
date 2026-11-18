// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// The loopback and WebView2 resource hosts serve only bundled files. Start the
// app only in the top-level document where the native bridge is installed.
if (window.top === window && window.orkbotDesktop && !window.orkbotBundledRenderer) {
  Object.defineProperty(window, "orkbotBundledRenderer", {
    value: true,
    writable: false,
    configurable: false,
  });
  if (window.orkbotDesktop.platform === "darwin") document.documentElement.dataset.os = "mac";
  void import("./native-app");
}
