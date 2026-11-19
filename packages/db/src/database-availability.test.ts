// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createLogger, createTestSink, installLogger } from "@orkbot/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  databaseOperationFailed,
  databaseOperationSucceeded,
  isDatabaseUnavailable,
  retryDatabaseOperation,
} from "./database-availability.js";

afterEach(() => {
  databaseOperationSucceeded();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
  vi.useRealTimers();
});

describe("database availability", () => {
  it("recognizes pg, socket, and nested driver failures while preserving other failures", () => {
    for (const error of [
      { code: "57P01" },
      { code: "P1001" },
      new Error("Query read timeout"),
      { meta: { driverAdapterError: { cause: { originalCode: "08006" } } } },
    ]) {
      expect(isDatabaseUnavailable(error)).toBe(true);
    }
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    for (const error of [
      cycle,
      { code: "57014" },
      { code: "23505" },
      { code: "P2002" },
      new Error("fetch failed", { cause: { code: "ECONNRESET" } }),
      Object.assign(new Error("connector socket closed"), { code: "ECONNRESET" }),
      new Error("timeout"),
    ]) {
      expect(isDatabaseUnavailable(error)).toBe(false);
    }
  });

  it("recognizes a native socket error after the pg boundary observes it", () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isDatabaseUnavailable(error)).toBe(false);
    databaseOperationFailed(error);
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it("logs one transition at the start and end of an outage", () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", sinks: [sink] }));
    databaseOperationFailed({ code: "57P01" });
    databaseOperationFailed({ code: "ECONNRESET" });
    databaseOperationSucceeded();
    databaseOperationSucceeded();
    expect(sink.events.map((event) => event.message)).toEqual(["db.unavailable", "db.available"]);
  });

  it("waits through a short outage and stops at the lease deadline", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValueOnce({ code: "57P01" }).mockResolvedValue("saved");
    const deadline = Date.now() + 3_000;
    const saved = retryDatabaseOperation(operation, { deadline: () => deadline });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(saved).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledTimes(2);

    operation.mockReset().mockRejectedValue({ code: "57P01" });
    const expired = retryDatabaseOperation(operation, { deadline: () => Date.now() + 0 });
    await expect(expired).rejects.toThrow("Database recovery exceeded the lease deadline");
    expect(operation).not.toHaveBeenCalled();
  });

  it("aborts the wait during shutdown without executing again", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue({ code: "57P01" });
    const waiting = retryDatabaseOperation(operation, {
      deadline: () => Date.now() + 60_000,
      signal: controller.signal,
    });
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
