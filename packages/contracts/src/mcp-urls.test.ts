// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import {
  MCP_AUTHORIZATION_URL_MAX_LENGTH,
  McpAuthorizationUrlSchema,
  McpRemoteEndpointSchema,
} from "./mcp.js";
import { appContract } from "./rpc.js";

function urlOfLength(length: number): string {
  const prefix = "https://auth.example.test/authorize?state=";
  return prefix + "x".repeat(length - prefix.length);
}

describe("MCP URL boundaries", () => {
  it("keeps endpoint URLs at 2048 while authorization requests have a separate bound", () => {
    expect(McpRemoteEndpointSchema.safeParse(urlOfLength(2048)).success).toBe(true);
    expect(McpRemoteEndpointSchema.safeParse(urlOfLength(2049)).success).toBe(false);
    expect(McpAuthorizationUrlSchema.safeParse(urlOfLength(2049)).success).toBe(true);
    expect(MCP_AUTHORIZATION_URL_MAX_LENGTH).toBe(8192);
    expect(McpAuthorizationUrlSchema.safeParse(urlOfLength(8192)).success).toBe(true);
    expect(McpAuthorizationUrlSchema.safeParse(urlOfLength(8193)).success).toBe(false);
  });

  it("bounds serialized URLs after percent encoding", () => {
    const endpoint = `https://mcp.example.test/${"界".repeat(300)}`;
    const authorization = `https://auth.example.test/authorize?scope=${"界".repeat(1000)}`;
    expect(endpoint.length).toBeLessThan(2048);
    expect(authorization.length).toBeLessThan(8192);
    expect(McpRemoteEndpointSchema.safeParse(endpoint).success).toBe(false);
    expect(McpAuthorizationUrlSchema.safeParse(authorization).success).toBe(false);
  });

  it.each([
    "https://user:fake-password@auth.example.test/authorize",
    "https://auth.example.test/authorize#fragment",
    "https://auth.example.test/authorize#",
    "ftp://auth.example.test/authorize",
    "javascript:alert(1)",
  ])("rejects unsafe URL structure: %s", (value) => {
    expect(McpRemoteEndpointSchema.safeParse(value).success).toBe(false);
    expect(McpAuthorizationUrlSchema.safeParse(value).success).toBe(false);
  });

  it("retains HTTP structure for operator-approved endpoints and local browser handoffs", () => {
    expect(McpRemoteEndpointSchema.safeParse("http://127.0.0.1:8080/mcp").success).toBe(true);
    expect(McpAuthorizationUrlSchema.safeParse("http://127.0.0.1:5173/authorize").success).toBe(
      true,
    );
  });

  it("applies the authorization bound to the actual OAuth begin output contract", () => {
    const schema = appContract.mcp.oauth.begin["~orpc"].outputSchema;
    if (!schema) throw new Error("Missing OAuth begin output schema");
    const result = {
      status: "authorization_required",
      sessionId: "session-fixture",
      authorizationUrl: urlOfLength(8192),
    };
    expect(schema.safeParse(result).success).toBe(true);
    expect(schema.safeParse({ ...result, authorizationUrl: urlOfLength(8193) }).success).toBe(
      false,
    );
  });
});
