// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const fixture = vi.hoisted(() => ({ reveal: vi.fn(), record: vi.fn() }));
vi.mock("@orkbot/adapters", async (original) => ({
  ...(await original<typeof import("@orkbot/adapters")>()),
  OrganizationVault: class {
    reveal = fixture.reveal;
  },
}));
vi.mock("@orkbot/db", async (original) => ({
  ...(await original<typeof import("@orkbot/db")>()),
  recordSecurityEvent: fixture.record,
}));

describe("organization vault reveal", () => {
  it("requires recent identity confirmation and does not audit the value", async () => {
    fixture.reveal.mockReset().mockResolvedValue({ value: "private-test-value" });
    fixture.record.mockReset().mockResolvedValue(undefined);
    const actor = {
      userId: "admin",
      spaceId: "space",
      email: "admin@test.invalid",
      isDeploymentOwner: false,
    };
    const confirmed = vi.fn().mockResolvedValue(false);
    const deps = {
      prisma: {},
      secrets: {},
      auth: { hasRecentIdentityConfirmation: confirmed },
      serverAIModels: { actor: async () => ({ ...actor, membershipVersion: "v1" }) },
      env: { agentRuntime: "pi", defaultProvider: "openrouter", defaultModel: "example/model" },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), {
      context: { actor, sessionId: "session" } as never,
    });
    await expect(client.organizationVault.reveal({ name: "secret" })).rejects.toMatchObject({
      code: "IDENTITY_CONFIRMATION_REQUIRED",
    });
    expect(fixture.reveal).not.toHaveBeenCalled();
    confirmed.mockResolvedValue(true);
    expect(await client.organizationVault.reveal({ name: "secret" })).toEqual({
      value: "private-test-value",
    });
    expect(fixture.reveal).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.record.mock.calls)).not.toContain("private-test-value");
  });
});
