// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { BrowserConnect } from "./browser-connect";
import { LocaleProvider } from "./components/LocaleProvider";
import { completeSsoCallback } from "./lib/sso-flow";
import { IntegrationCallbackPage } from "./pages/IntegrationCallback";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { SlackInstallCallbackPage } from "./pages/SlackInstallCallback";

function SsoCallback() {
  useEffect(() => {
    completeSsoCallback();
  }, []);
  return null;
}

export function BrowserCallbacks() {
  return (
    <LocaleProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/sso/callback" element={<SsoCallback />} />
          <Route path="/integrations/callback" element={<IntegrationCallbackPage />} />
          <Route path="/mcp/oauth/callback" element={<McpOAuthCallbackPage />} />
          <Route path="/messaging/slack/callback" element={<SlackInstallCallbackPage />} />
          <Route path="*" element={<BrowserConnect />} />
        </Routes>
      </BrowserRouter>
    </LocaleProvider>
  );
}
