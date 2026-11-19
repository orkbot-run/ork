// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export const MCP_TOOL_INACTIVITY_MS = 4 * 60_000;
export const MCP_TOOL_MAX_TOTAL_MS = 15 * 60_000;

export class McpToolTimeoutError extends McpError {
  constructor(message: string) {
    super(ErrorCode.RequestTimeout, message);
    this.name = "McpToolTimeoutError";
  }
}

/** SDK progress registers a token and resets inactivity. A separate deadline is
 * necessary: the SDK checks maxTotalTimeout only when progress arrives. */
export async function callMcpToolWithDeadline(
  client: Pick<Client, "callTool">,
  name: string,
  args: Record<string, unknown>,
  callerSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(
    () =>
      controller.abort(new McpToolTimeoutError("MCP tool exceeded the 15 minute total timeout")),
    MCP_TOOL_MAX_TOTAL_MS,
  );
  deadline.unref?.();
  try {
    return await client.callTool({ name, arguments: args }, undefined, {
      signal: controller.signal,
      timeout: MCP_TOOL_INACTIVITY_MS,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: MCP_TOOL_MAX_TOTAL_MS,
      // The SDK only requests progress notifications when a callback is present.
      onprogress: () => {},
    });
  } catch (error) {
    // Preserve which event won, even when caller cancellation and timeout occur
    // together before the rejected promise's continuation is scheduled.
    const data =
      error instanceof McpError && typeof error.data === "object" && error.data !== null
        ? (error.data as Record<string, unknown>)
        : undefined;
    if (
      error instanceof McpError &&
      error.code === ErrorCode.RequestTimeout &&
      (data?.timeout === MCP_TOOL_INACTIVITY_MS || data?.maxTotalTimeout === MCP_TOOL_MAX_TOTAL_MS)
    ) {
      throw new McpToolTimeoutError("MCP tool timed out waiting for a response or progress");
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}

/** Protocol/application errors leave the transport reusable. HTTP/auth failures
 * and locally enforced silence deadlines require a fresh session next time. */
export function isBrokenMcpCall(error: unknown): boolean {
  return (
    error instanceof McpToolTimeoutError ||
    (error instanceof McpError && error.code === -32302) ||
    error instanceof UnauthorizedError ||
    error instanceof InvalidTokenError ||
    error instanceof StreamableHTTPError ||
    error instanceof SseError ||
    (error instanceof Error &&
      "code" in error &&
      ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOTCONN", "ERR_STREAM_DESTROYED"].includes(
        String(error.code),
      ))
  );
}
