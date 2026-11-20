// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { databaseOperationFailed, isDatabaseUnavailable } from "@orkbot/db";
import { getLogContext } from "@orkbot/logging";
import { markExpectedFailure } from "@orkbot/logging/hono";
import type { ErrorHandler, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const databaseErrorHandler: ErrorHandler = (error, c) => {
  if (isDatabaseUnavailable(error)) {
    databaseOperationFailed(error);
    markExpectedFailure();
    c.header("Retry-After", "3");
    return c.json({ error: "Database temporarily unavailable" }, 503);
  }
  // Preserve Hono's default handling, including its HTTP exceptions.
  if (error instanceof HTTPException) return error.getResponse();
  return c.text("Internal Server Error", 500);
};

export const retryUnavailableRequests: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status >= 500 && getLogContext()["db.unavailable"] === true) {
    c.res = c.json({ error: "Database temporarily unavailable" }, 503);
  }
  if (c.res.status === 503 && !c.res.headers.has("Retry-After")) c.header("Retry-After", "3");
};
