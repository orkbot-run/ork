// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SecretStore } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiOAuthLogins } from "./pi-oauth.js";
import type { AIActor, ServerAICatalog } from "./server-ai-catalog.js";
import { ServerAIOAuth } from "./server-ai-oauth.js";

const actor: AIActor = {
  userId: "user",
  spaceId: "workspace",
  sessionId: "session",
  membershipVersion: "admission",
};
const input = {
  provider: "anthropic",
  connectionId: null,
  label: "Team",
  models: ["model"],
  concurrencyLimit: 2,
  monthlyBudgetMicros: 100,
};
const services: ServerAIOAuth[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});
function fixture() {
  const account = {
    id: "account",
    provider: "anthropic",
    label: "Team",
    models: ["model"],
    state: "active",
    revision: 1,
    concurrencyLimit: 2,
    monthlyBudgetMicros: 100,
  };
  const catalog = {
    adminIdentity: vi.fn(async () => ({ accountKey: "a".repeat(64), bindingVersion: 1 })),
    accounts: vi.fn(async () => [account]),
    create: vi.fn(async () => account),
    reconnect: vi.fn(async () => account),
  };
  const logins = new PiOAuthLogins(
    async (_provider, _type, interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://claude.ai/oauth/authorize?code=true",
        instructions: "Open",
      });
      await interaction.prompt({ type: "manual_code", message: "Paste code" });
      return {
        type: "oauth",
        access: "fixture-private-access",
        refresh: "fixture-private-refresh",
        expires: Date.now() + 3_600_000,
      };
    },
    undefined,
    "server-ai",
  );
  const service = new ServerAIOAuth(
    {
      prisma: {} as PrismaClient,
      secrets: {} as SecretStore,
      catalog: catalog as unknown as ServerAICatalog,
    },
    logins,
  );
  services.push(service);
  return { service, catalog, account };
}
async function ready(service: ServerAIOAuth, loginId: string) {
  await service.submit(actor, loginId, "fixture-code");
  await vi.waitFor(async () =>
    expect(await service.complete(actor, loginId)).toEqual({ status: "ready" }),
  );
}

describe("installation AI sign-in", () => {
  it("keeps provider credentials on the installation and consumes an attempt once", async () => {
    const { service, catalog } = fixture();
    const started = await service.begin(actor, input);
    await ready(service, started.loginId);
    const result = await service.finish(actor, started.loginId);
    expect(result.id).toBe("account");
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    expect(catalog.create).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        plaintext: expect.stringContaining("fixture-private-access"),
        label: "Team",
        models: ["model"],
      }),
    );
    await expect(service.finish(actor, started.loginId)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(catalog.create).toHaveBeenCalledOnce();
  });
  it.each([{ sessionId: "other" }, { membershipVersion: "new-admission" }])(
    "rejects another session or admission %j before accepting a code",
    async (patch) => {
      const { service, catalog } = fixture();
      const started = await service.begin(actor, input);
      await expect(
        service.submit({ ...actor, ...patch }, started.loginId, "fixture-code"),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(catalog.create).not.toHaveBeenCalled();
    },
  );
  it("rejects a changed installation binding or administrator identity", async () => {
    const { service, catalog } = fixture();
    const started = await service.begin(actor, input);
    await ready(service, started.loginId);
    catalog.adminIdentity.mockResolvedValue({ accountKey: "b".repeat(64), bindingVersion: 2 });
    await expect(service.finish(actor, started.loginId)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(catalog.create).not.toHaveBeenCalled();
  });
  it("does not revive an account disabled while the provider sign-in was open", async () => {
    const { service, catalog, account } = fixture();
    const started = await service.begin(actor, { ...input, connectionId: account.id });
    await ready(service, started.loginId);
    account.revision++;
    account.state = "disabled";
    await expect(service.finish(actor, started.loginId)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(catalog.reconnect).not.toHaveBeenCalled();
  });
});
