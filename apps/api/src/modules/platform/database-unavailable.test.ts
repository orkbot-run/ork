// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isDatabaseUnavailable } from "@orkbot/db";
import { createLogger, createTestSink, enrichLogContext, installLogger } from "@orkbot/logging";
import { requestLogging } from "@orkbot/logging/hono";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, expect, it } from "vitest";
import { handleRpcError } from "../../app.js";
import { databaseErrorHandler, retryUnavailableRequests } from "./database-unavailable.js";

afterEach(() => installLogger(createLogger({ service: "test", level: "off", sinks: [] })));

it("returns retryable 503 for failures in session middleware without reporting each request", async () => {
  const sink = createTestSink();
  const logger = createLogger({ service: "test", sinks: [sink] });
  installLogger(logger);
  const app = new Hono();
  app.onError(databaseErrorHandler);
  app.use("*", requestLogging(logger, { isExpectedError: isDatabaseUnavailable }));
  app.use("*", retryUnavailableRequests);
  app.use("*", async () => {
    throw Object.assign(new Error("server restarting"), { code: "57P01" });
  });
  app.get("/rpc/test", (c) => c.json({ ok: true }));
  const response = await app.request("/rpc/test");
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("3");
  expect(sink.events.filter((event) => event.level === "error")).toEqual([]);
});

it("translates database failures handled internally by authentication while preserving other errors", async () => {
  const app = new Hono();
  app.onError(databaseErrorHandler);
  app.use("*", requestLogging());
  app.use("*", retryUnavailableRequests);
  app.get("/auth", (c) => {
    enrichLogContext({ "db.unavailable": true });
    return c.text("auth error", 500);
  });
  app.get("/other", () => {
    throw new Error("other error");
  });
  app.get("/forbidden", () => {
    throw new HTTPException(403);
  });
  expect((await app.request("/auth")).status).toBe(503);
  expect((await app.request("/other")).status).toBe(500);
  expect((await app.request("/forbidden")).status).toBe(403);
});

it("translates RPC database errors to SERVICE_UNAVAILABLE", () => {
  expect(() => handleRpcError({ code: "57P03" }, ["threads", "list"])).toThrow(ORPCError);
  try {
    handleRpcError({ code: "57P03" }, ["threads", "list"]);
  } catch (error) {
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
  }
});
