// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  callMcpToolWithDeadline,
  isBrokenMcpCall,
  MCP_TOOL_INACTIVITY_MS,
  MCP_TOOL_MAX_TOTAL_MS,
  McpToolTimeoutError,
} from "./mcp-tool-call.js";

afterEach(() => vi.useRealTimers());

async function fixture() {
  let request: { id: number; params: { _meta: { progressToken: number } } };
  const transport: Transport = {
    start: async () => {},
    close: vi.fn(async () => {}),
    send: async (message) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize") {
        queueMicrotask(() =>
          transport.onmessage?.({
            jsonrpc: "2.0",
            id: message.id!,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            },
          }),
        );
      } else if (message.method === "tools/call") request = message as typeof request;
    },
  };
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  vi.useFakeTimers();
  const result = callMcpToolWithDeadline(client, "slow", {});
  // Observe rejection immediately; advancing fake time may reject before assertions.
  const settled = result.then(
    (value) => value,
    (error) => error,
  );
  await Promise.resolve();
  let progress = 0;
  return {
    client,
    transport,
    result,
    settled,
    progress: () =>
      transport.onmessage?.({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: request.params._meta.progressToken,
          progress: ++progress,
        },
      }),
    finish: () =>
      transport.onmessage?.({ jsonrpc: "2.0", id: request.id, result: { content: [] } }),
  };
}

it("accepts a tool response after two minutes without progress", async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(120_000);
  f.finish();
  expect(await f.result).toEqual({ content: [] });
  await f.client.close();
});

it("resets inactivity on real SDK progress and enforces the hard cap without another progress event", async () => {
  const f = await fixture();
  for (let elapsed = 30_000; elapsed < MCP_TOOL_MAX_TOTAL_MS; elapsed += 30_000) {
    await vi.advanceTimersByTimeAsync(30_000);
    f.progress();
  }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await f.settled).toBeInstanceOf(McpToolTimeoutError);
  expect((await f.settled).message).toContain("15 minute");
  // Local timeout only sends request cancellation; pool decides retirement.
  expect(f.transport.close).not.toHaveBeenCalled();
  await f.client.close();
});

it("times out after a full inactivity window following progress", async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(120_000);
  f.progress();
  await vi.advanceTimersByTimeAsync(MCP_TOOL_INACTIVITY_MS - 1);
  let done = false;
  void f.settled.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await f.settled).toBeInstanceOf(McpToolTimeoutError);
  await f.client.close();
});

it("does not classify a server JSON-RPC timeout or closure code as a broken connection", () => {
  expect(isBrokenMcpCall(new McpError(ErrorCode.RequestTimeout, "application timeout"))).toBe(
    false,
  );
  expect(isBrokenMcpCall(new McpError(ErrorCode.ConnectionClosed, "application error"))).toBe(
    false,
  );
});
