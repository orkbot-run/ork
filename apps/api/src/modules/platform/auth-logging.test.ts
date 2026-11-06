// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createLogger, createTestSink } from "@orkbot/logging";
import { describe, expect, it, vi } from "vitest";
import { authenticationLogger } from "./auth-logging.js";

describe("authentication diagnostics", () => {
  it("writes useful JSON log fields while preserving request correlation", () => {
    const sink = createTestSink();
    const logger = createLogger({ service: "test-api", level: "error", sinks: [sink] });
    logger.withContext({ "request.id": "test-request" }, () => {
      authenticationLogger(() => logger).log("error", "Failed to validate authorization code", {
        status: 403,
        error: "access_denied",
        error_description: "private upstream detail",
      });
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      message: "auth.request.failed",
      "request.id": "test-request",
      "auth.stage": "token_exchange",
      "http.response.status_code": 403,
      "auth.error_code": "access_denied",
    });
    expect(JSON.stringify(sink.events)).not.toContain("private upstream detail");
  });

  it.each([
    [{ status: 403, error: "access_denied" }, 403, "access_denied"],
    [{ status: 401, error: "invalid_client" }, 401, "invalid_client"],
    [{ statusCode: 400, body: { error: "invalid_grant" } }, 400, "invalid_grant"],
    [{ response: { status: 502 }, data: { error: "server_error" } }, 502, "server_error"],
  ])("preserves HTTP and protocol errors from plain response objects", (failure, status, code) => {
    const error = vi.fn();
    authenticationLogger(() => ({ error })).log(
      "error",
      "Failed to validate authorization code",
      failure,
    );
    expect(error).toHaveBeenCalledWith("auth.request.failed", {
      "auth.stage": "token_exchange",
      "http.response.status_code": status,
      "auth.error_code": code,
    });
  });

  it("records network causes without exposing error messages or request details", () => {
    const error = vi.fn();
    const secret = "fake-private-credential";
    const failure = new Error(`fetch failed with ${secret}`, {
      cause: Object.assign(new Error(`private URL ${secret}`), { code: "ENOTFOUND" }),
    });
    authenticationLogger(() => ({ error })).log(
      "error",
      "Failed to validate authorization code",
      {
        cause: failure.cause,
        message: secret,
        body: { client_secret: secret, code: secret, error_description: secret },
        request: { url: `https://identity.example.test/token?code=${secret}` },
        headers: { authorization: `Bearer ${secret}` },
      },
      failure,
    );
    expect(error).toHaveBeenCalledWith("auth.request.failed", {
      "auth.stage": "token_exchange",
      "auth.error_code": "ENOTFOUND",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it("uses fixed categories for unknown messages and ignores arbitrary codes and invalid statuses", () => {
    const error = vi.fn();
    authenticationLogger(() => ({ error })).log(
      "error",
      "private provider detail",
      null,
      {
        error: "private-provider-detail",
        status: "403",
        code: "arbitrary-private-value",
      },
      { statusCode: Number.NaN },
      { status: 999 },
    );
    expect(error).toHaveBeenCalledWith("auth.request.failed", { "auth.stage": "authentication" });
  });

  it("keeps distinct callback stages and resolves the logger in the current request", () => {
    const first = { error: vi.fn() };
    const second = { error: vi.fn() };
    const current = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const logger = authenticationLogger(current);
    logger.log("error", "OAuth issuer mismatch", { received: "private issuer" });
    logger.log("error", "Unable to get user info");
    expect(first.error).toHaveBeenCalledWith("auth.request.failed", {
      "auth.stage": "issuer_validation",
    });
    expect(second.error).toHaveBeenCalledWith("auth.request.failed", { "auth.stage": "user_info" });
  });
});
