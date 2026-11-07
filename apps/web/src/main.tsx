// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited renderer bootstrapping is packaged separately in native-app.tsx.

import { createRoot } from "react-dom/client";
import { browserEntry } from "./lib/browser-entry";
import { retireBrowserShell } from "./pwa/retire";

// Product code belongs to the desktop bundle. The server only serves browser handoff and
// protocol callbacks, and never starts product sessions or background subscriptions.
const entry = browserEntry(window.location.pathname, Boolean(window.orkbotDesktop));
if (entry === "native") {
  if (!window.orkbotBundledRenderer) {
    void import("./browser-native-update").then(({ BrowserNativeUpdate }) => {
      createRoot(document.getElementById("root")!).render(<BrowserNativeUpdate />);
    });
  }
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
