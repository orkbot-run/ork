// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MinimumClientBuilds, ProtocolRange } from "@orkbot/contracts";
import {
  CLIENT_BUILD_HEADER,
  CLIENT_PROTOCOL_HEADER,
  CLIENT_UPDATE_REQUIRED,
  SERVER_BUILD_HEADER,
  SERVER_PROTOCOL_RANGE,
} from "@orkbot/contracts";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";
import { clientBuildMiddleware } from "./client-build.js";
import { clientProtocolMiddleware } from "./client-protocol.js";

function fixture(
  range: Readonly<ProtocolRange> = SERVER_PROTOCOL_RANGE,
  minimums: MinimumClientBuilds = {},
) {
  const app = new Hono();
  let handled = 0;
  app.use("*", cors({ origin: "orkbot://", credentials: true }));
  app.get("/api/auth/capabilities", (c) => c.json({ protocol: range }));
  app.use("/rpc/*", clientProtocolMiddleware(range));
  app.use("/rpc/*", clientBuildMiddleware({ webBuild: "20261107000000", minimums }));
  app.post("/rpc/mutate", async (c) => {
    handled += 1;
    await c.req.json();
    return c.json({ json: { ok: true } });
  });
  app.post("/rpc/serverUpdates/status", (c) => c.json({ json: { ok: true } }));
  app.post("/rpc/health", (c) => c.json({ json: { ok: true, version: "0.1.0" } }));
  app.post("/rpc/events", (c) => {
    handled += 1;
    return c.body('data: {"json":{"type":"heartbeat"}}\n\n', 200, {
      "content-type": "text/event-stream",
    });
  });
  return { app, handled: () => handled };
}

function call(app: Hono, protocol?: string, build?: string) {
  return app.request("/rpc/mutate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(protocol === undefined ? {} : { [CLIENT_PROTOCOL_HEADER]: protocol }),
      ...(build === undefined ? {} : { [CLIENT_BUILD_HEADER]: build }),
    },
    body: "{}",
  });
}

describe("RPC protocol admission", () => {
  it.each([undefined, "1"])("accepts legacy or current client header %j", async (protocol) => {
    const { app, handled } = fixture();
    const response = await call(app, protocol);
    expect(response.status).toBe(200);
    expect(response.headers.get(SERVER_BUILD_HEADER)).toBe("20261107000000");
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(handled()).toBe(1);
  });

  it.each(["", "0", "01", "-1", "1.5", "1, 2", "9007199254740992"])(
    "rejects malformed version %j without dispatching the mutation",
    async (protocol) => {
      const { app, handled } = fixture();
      const response = await call(app, protocol);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: "Invalid client protocol",
        },
      });
      expect(handled()).toBe(0);
    },
  );

  it("returns the existing structured upgrade error for unsupported client versions", async () => {
    const { app, handled } = fixture();
    const response = await call(app, "2");
    expect(response.status).toBe(426);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      json: {
        defined: false,
        code: CLIENT_UPDATE_REQUIRED,
        status: 426,
        message: "Update required",
      },
    });
    expect(handled()).toBe(0);
  });

  it("keeps missing-header callers on version one instead of upgrading them implicitly", async () => {
    const { app, handled } = fixture({ min: 2, max: 2 });
    expect((await call(app)).status).toBe(426);
    expect((await call(app, "2")).status).toBe(200);
    expect(handled()).toBe(1);
  });

  it("keeps only update recovery routes reachable across incompatible versions", async () => {
    const { app } = fixture({ min: 2, max: 2 }, { mobile: "20261101000000" });
    const headers = {
      [CLIENT_PROTOCOL_HEADER]: "1",
      [CLIENT_BUILD_HEADER]: "mobile/20261031000000",
    };
    expect(
      (await app.request("/rpc/serverUpdates/status", { method: "POST", headers })).status,
    ).toBe(200);
    expect(
      (await app.request("/rpc/serverUpdates/status/extra", { method: "POST", headers })).status,
    ).toBe(426);
    expect((await app.request("/rpc/mutate", { method: "POST", headers })).status).toBe(426);
    expect((await app.request("/rpc/serverUpdates/status", { method: "POST" })).status).toBe(426);
  });

  it("allows the version-one health probe through both gates without opening other requests", async () => {
    const { app } = fixture({ min: 2, max: 2 }, { mobile: "20261101000000" });
    const headers = {
      [CLIENT_PROTOCOL_HEADER]: "1",
      [CLIENT_BUILD_HEADER]: "mobile/20261031000000",
    };
    expect((await app.request("/rpc/health", { method: "POST", headers })).status).toBe(200);
    expect((await app.request("/rpc/health", { method: "GET", headers })).status).toBe(426);
    expect((await app.request("/rpc/health/extra", { method: "POST", headers })).status).toBe(426);
    expect((await app.request("/rpc/mutate", { method: "POST", headers })).status).toBe(426);
    expect(
      (
        await app.request("/rpc/health", {
          method: "POST",
          headers: { ...headers, [CLIENT_PROTOCOL_HEADER]: "2" },
        })
      ).status,
    ).toBe(426);
  });

  it("applies protocol and timestamp requirements independently", async () => {
    const { app, handled } = fixture(SERVER_PROTOCOL_RANGE, { mobile: "20261101000000" });
    expect((await call(app, "1", "mobile/20261031000000")).status).toBe(426);
    expect((await call(app, "1", "mobile/20261101000000")).status).toBe(200);
    expect((await call(app, "2", "mobile/20261107000000")).status).toBe(426);
    expect((await call(app, "bad", "mobile/20261031000000")).status).toBe(400);
    expect(handled()).toBe(1);
  });

  it("keeps discovery available and allows the native protocol header through CORS", async () => {
    const { app } = fixture();
    expect(
      (await app.request("/api/auth/capabilities", { headers: { [CLIENT_PROTOCOL_HEADER]: "99" } }))
        .status,
    ).toBe(200);
    const response = await app.request("/rpc/mutate", {
      method: "OPTIONS",
      headers: {
        origin: "orkbot://",
        "access-control-request-method": "POST",
        "access-control-request-headers": CLIENT_PROTOCOL_HEADER,
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("orkbot://");
    expect(response.headers.get("access-control-allow-headers")).toContain(CLIENT_PROTOCOL_HEADER);
  });

  it("admits compatible SSE without reading or changing its response body", async () => {
    const { app } = fixture();
    const response = await app.request("/rpc/events", {
      method: "POST",
      headers: { [CLIENT_PROTOCOL_HEADER]: "1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe('data: {"json":{"type":"heartbeat"}}\n\n');
  });
});
