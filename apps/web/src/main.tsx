// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited renderer bootstrapping is preserved in native-app.tsx.

import { createRoot } from "react-dom/client";
import { browserEntry } from "./lib/browser-entry";
import { retireBrowserShell } from "./pwa/retire";

// The native bridge is installed before page scripts. A browser never mounts the product
// or starts its session queries, service worker, analytics, or background subscriptions.
const entry = browserEntry(window.location.pathname, Boolean(window.orkbotDesktop));
if (entry === "native") {
  void import("./native-app");
} else if (entry === "callback") {
  void retireBrowserShell();
  void import("./browser-callbacks").then(({ BrowserCallbacks }) => {
    createRoot(document.getElementById("root")!).render(<BrowserCallbacks />);
  });
} else {
  void retireBrowserShell();
  void import("./browser-connect").then(({ BrowserConnect }) => {
    createRoot(document.getElementById("root")!).render(<BrowserConnect />);
  });
}
