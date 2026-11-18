// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { nativeProtocolGuard } from "./native-protocol-guard.js";

function fixture(registered: boolean) {
  const app = new Hono();
  app.use(
    "/api/auth/native/*",
    nativeProtocolGuard(async () => registered),
  );
  app.all("/api/auth/native/*", (c) => c.json({ accepted: true }));
  return app;
}

describe("native identity protocol guard", () => {
  it("lets the server page read workspace status on a registered server", async () => {
    const response = await fixture(true).request("/api/auth/native/workspace-status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
  });

  it("continues to reject legacy endpoints and non-GET status requests", async () => {
    const app = fixture(true);
    for (const [method, path] of [
      ["POST", "/api/auth/native/workspace-status"],
      ["GET", "/api/auth/native/workspace-status/extra"],
      ["POST", "/api/auth/native/pair"],
    ] as const) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: "update_required", identityProtocol: 2 });
    }
  });

  it("keeps current workspace endpoints and unregistered servers available", async () => {
    expect((await fixture(true).request("/api/auth/native/workspace/connect")).status).toBe(200);
    expect((await fixture(false).request("/api/auth/native/pair", { method: "POST" })).status).toBe(
      200,
    );
  });
});
