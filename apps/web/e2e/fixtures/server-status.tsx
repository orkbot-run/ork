// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { createRoot } from "react-dom/client";
import type { ServerPageState } from "../../src/browser-connect";
import { BrowserConnectView } from "../../src/browser-connect";

const requested = new URLSearchParams(location.search).get("state");
const state: ServerPageState =
  requested === "loading" ||
  requested === "connected" ||
  requested === "unknown" ||
  requested === "unavailable"
    ? requested
    : "setup";
createRoot(document.getElementById("root")!).render(
  <BrowserConnectView state={state} onRetry={() => location.reload()} />,
);
