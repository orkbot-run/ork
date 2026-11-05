// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/account/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    // The browser sees one origin; production uses the same reverse-proxy split.
    proxy: {
      "/account/api/auth": "http://127.0.0.1:3200",
      "/.well-known": "http://127.0.0.1:3200",
    },
  },
});
