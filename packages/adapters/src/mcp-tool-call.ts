// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { AsyncLocalStorage } from "node:async_hooks";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpFormRequest, McpFormResponse } from "@orkbot/contracts";
import { McpFormResponseSchema, validateMcpFormResponse } from "@orkbot/contracts";
import { z } from "zod";
import { combineSignals } from "./connector-safety.js";
import { mcpFormRequest } from "./mcp-transport-form.js";

export const MCP_TOOL_INACTIVITY_MS = 4 * 60_000;
export const MCP_TOOL_MAX_TOTAL_MS = 15 * 60_000;

export class McpToolTimeoutError extends McpError {
  constructor(message: string) {
    super(ErrorCode.RequestTimeout, message);
    this.name = "McpToolTimeoutError";
  }
}

export interface McpFormCallOptions {
  integrationName: string;
  secrets?: () => readonly string[];
  elicit: (request: McpFormRequest, signal: AbortSignal) => Promise<McpFormResponse>;
}

interface McpCallScope {
  client: Pick<Client, "callTool">;
  signal: AbortSignal;
  active: boolean;
  form?: McpFormCallOptions;
  pause: () => () => void;
}

export const mcpCallScope = new AsyncLocalStorage<McpCallScope>();

/** Register the official SDK handler once; callbacks remain scoped to each invocation. */
export function installMcpFormHandler(
  client: Client,
  getExclusiveScope?: () => McpCallScope | undefined,
  controllers = new Set<AbortController>(),
): () => void {
  // Use a permissive params envelope here: the official SDK still validates the
  // protocol, while our converter sees unknown schema keywords and can refuse them.
  client.setRequestHandler(
    z.object({
      method: z.literal("elicitation/create"),
      params: z.record(z.string(), z.unknown()),
    }),
    async (request, extra) => {
      const candidate = mcpCallScope.getStore();
      const scope = candidate?.client === client ? candidate : getExclusiveScope?.();
      if (
        !scope?.active ||
        (scope.client !== client && scope !== getExclusiveScope?.()) ||
        !scope.form?.elicit
      )
        return { action: "decline" };
      const form = mcpFormRequest(
        scope.form.integrationName,
        request.params,
        scope.form.secrets?.(),
      );
      if (!form) return { action: "decline" };
      const controller = new AbortController();
      controllers.add(controller);
      const signal = combineSignals(extra.signal, scope.signal, controller.signal);
      if (signal.aborted) {
        controllers.delete(controller);
        return { action: "cancel" };
      }
      const resume = scope.pause();
      let onAbort: (() => void) | undefined;
      try {
        const cancelled = new Promise<{ action: "cancel" }>((resolve) => {
          onAbort = () => resolve({ action: "cancel" });
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([scope.form.elicit(form, signal), cancelled]);
        if (signal.aborted || !scope.active) return { action: "cancel" };
        const parsed = McpFormResponseSchema.safeParse(result);
        return parsed.success && validateMcpFormResponse(form.fields, parsed.data)
          ? parsed.data
          : { action: "decline" };
      } catch {
        // Broker errors can contain answer values; never forward them to SDK logs.
        return { action: signal.aborted ? "cancel" : "decline" };
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
        controllers.delete(controller);
        controller.abort();
        resume();
      }
    },
  );
  const abort = () => {
    for (const controller of controllers) controller.abort();
  };
  const previousOnClose = client.onclose;
  client.onclose = () => {
    abort();
    previousOnClose?.();
  };
  return abort;
}

/** Own both clocks so human input can suspend them without changing SDK internals. */
export async function callMcpToolWithDeadline(
  client: Pick<Client, "callTool">,
  name: string,
  args: Record<string, unknown>,
  callerSignal?: AbortSignal,
  form?: McpFormCallOptions,
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onAbort();
  else callerSignal?.addEventListener("abort", onAbort, { once: true });
  let totalRemaining = MCP_TOOL_MAX_TOTAL_MS;
  let idleRemaining = MCP_TOOL_INACTIVITY_MS;
  let started = Date.now();
  let pauses = 0;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    totalRemaining -= Date.now() - started;
    idleRemaining -= Date.now() - started;
  };
  const start = () => {
    started = Date.now();
    totalTimer = setTimeout(
      () =>
        controller.abort(new McpToolTimeoutError("MCP tool exceeded the 15 minute total timeout")),
      Math.max(0, totalRemaining),
    );
    idleTimer = setTimeout(
      () =>
        controller.abort(
          new McpToolTimeoutError("MCP tool timed out waiting for a response or progress"),
        ),
      Math.max(0, idleRemaining),
    );
    totalTimer.unref?.();
    idleTimer.unref?.();
  };
  const scope: McpCallScope = {
    client,
    signal: controller.signal,
    active: true,
    form,
    pause: () => {
      if (pauses++ === 0) stop();
      let resumed = false;
      return () => {
        if (resumed) return;
        resumed = true;
        if (--pauses === 0 && scope.active && !controller.signal.aborted) start();
      };
    },
  };
  start();
  try {
    return await mcpCallScope.run(scope, () =>
      client.callTool({ name, arguments: args }, undefined, {
        signal: controller.signal,
        // The SDK exposes no public timer suspension API. Its longest supported
        // timer is only a backstop; the pausable clocks above enforce our limits.
        timeout: 2_147_483_647,
        onprogress: () => {
          if (pauses === 0) stop();
          idleRemaining = MCP_TOOL_INACTIVITY_MS;
          if (pauses === 0) start();
        },
      }),
    );
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    scope.active = false;
    controller.abort();
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
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
