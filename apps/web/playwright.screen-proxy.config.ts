// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Modified for the Tauri desktop path. Inherited material remains Apache-2.0.

import { defineConfig } from "@playwright/test";

// These local fixtures exercise the real Vite proxy without starting an API, database, or desktop app.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "screen-proxy-isolation.spec.ts",
  workers: 1,
  use: { headless: true },
});
