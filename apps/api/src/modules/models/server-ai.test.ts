// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const account = {
  id: "connection",
  label: "Team",
  provider: "openrouter",
  models: ["example/model"],
  state: "active",
  revision: 1,
  concurrencyLimit: 2,
  monthlyBudgetMicros: 100,
};
const input = {
  connection: { provider: "openrouter", modelId: "example/model", apiKey: "fixture-private-key" },
  models: ["example/model"],
  label: "Team",
  concurrencyLimit: 2,
  monthlyBudgetMicros: 100,
};

function fixture(canManageServer = true) {
  const actor = {
    userId: "member",
    spaceId: "workspace",
    email: "member@example.test",
    isDeploymentOwner: false,
  };
  const principal = {
    userId: actor.userId,
    spaceId: actor.spaceId,
    membershipVersion: "admission",
  };
  const serverAI = {
    permissions: vi.fn(async () => ({ canManageServer, canManageWorkspace: false })),
    list: vi.fn(async () => []),
    workspaceBudget: vi.fn(async () => null),
    accounts: vi.fn(async () => [account]),
    create: vi.fn(async () => account),
  };
  const deps = {
    prisma: {},
    secrets: {},
    serverAI,
    serverAIModels: { actor: vi.fn(async () => principal) },
    env: { agentRuntime: "pi", defaultProvider: "openrouter", defaultModel: "example/model" },
    modelConnectionFetch: vi.fn(async () => Response.json({})),
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), {
    context: { actor, sessionId: "verified-session" } as never,
  });
  return { client, deps, serverAI, principal };
}

describe("installation AI RPC boundary", () => {
  it("checks explicit server delegation before probing or receiving a saved credential", async () => {
    const { client, serverAI, deps, principal } = fixture(false);
    const status = await client.serverAI.status();
    expect(status).toMatchObject({ available: true, canManageServer: false, accounts: [] });
    expect(serverAI.accounts).not.toHaveBeenCalled();
    await expect(client.serverAI.create(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
    expect(serverAI.create).not.toHaveBeenCalled();
    expect(serverAI.permissions).toHaveBeenCalledWith({
      ...principal,
      sessionId: "verified-session",
    });
  });
  it("keeps prepared credentials on the installation and never returns them", async () => {
    const { client, serverAI, principal } = fixture();
    const result = await client.serverAI.create(input);
    expect(result).toEqual(account);
    expect(serverAI.create).toHaveBeenCalledWith(
      { ...principal, sessionId: "verified-session" },
      {
        label: "Team",
        provider: "openrouter",
        models: ["example/model"],
        concurrencyLimit: 2,
        monthlyBudgetMicros: 100,
        plaintext: expect.stringContaining("fixture-private-key"),
      },
    );
    expect(JSON.stringify(result)).not.toContain("fixture-private-key");
    await expect(client.models.connect(input.connection)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client.models.setWorkspacePolicy(input.connection)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client.models.clearWorkspacePolicy()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("does not expose a credential echoed by a failed provider probe", async () => {
    const { client, deps } = fixture();
    deps.modelConnectionCheck = vi.fn(async () => {
      throw new Error("Provider echoed fixture-private-key");
    });
    await expect(client.serverAI.create(input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Could not verify the AI connection.",
    });
  });
});

it("rejects every legacy credential path before accessing the personal store in a managed workspace", async () => {
  const { client, deps } = fixture();
  for (const work of [
    () =>
      client.models.probeOpenAiCompatible({
        baseUrl: "https://example.test/v1",
        credentialId: "personal",
      }),
    () => client.models.probeCatalog({ provider: "openai", apiKey: "fixture-key" }),
    () => client.models.submitOAuthCode({ loginId: "personal", code: "code" }),
    () => client.models.completeOAuth({ loginId: "personal" }),
    () => client.models.rename({ credentialId: "personal", label: "Changed" }),
    () => client.models.disconnect({ provider: "openai", credentialId: "personal" }),
  ])
    await expect(work()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(deps.modelConnectionFetch).not.toHaveBeenCalled();
});

it("returns only assigned account picker metadata without reading personal credentials", async () => {
  const { client, serverAI, principal } = fixture();
  serverAI.list.mockResolvedValue([
    { ...account, enabled: true, allowedModels: ["example/model", "retired"], isDefault: true },
  ] as never);
  expect(await client.models.credentials()).toEqual([
    {
      id: account.id,
      provider: account.provider,
      label: account.label,
      managed: true,
      hasKey: true,
      isDefault: true,
      enabledModelIds: ["example/model"],
    },
  ]);
  expect(serverAI.list).toHaveBeenCalledWith(principal);
});
