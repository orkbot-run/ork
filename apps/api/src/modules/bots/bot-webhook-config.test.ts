// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
import type { Actor } from "@orkbot/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const actor = {
  spaceId: "space-a",
  userId: "user-a",
  email: "test@example.test",
  isDeploymentOwner: false,
} satisfies Actor;
function harness() {
  const findBot = vi.fn(async ({ where }) =>
    where.id === "owned" ? { id: "owned", webhookSecretId: "secret-id" } : null,
  );
  const findSecret = vi.fn(async () => ({ id: "secret-id", ciphertext: "cipher" }));
  const load = vi.fn(async () => "existing-key");
  const handler = new RPCHandler(
    createRouter({
      prisma: { bot: { findFirst: findBot }, secret: { findFirst: findSecret } },
      secrets: { load },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake",
        webOrigin: "http://localhost",
        screenProxySecret: "fake",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/ork-webhook-config-test",
    } as unknown as RouterDeps),
  );
  async function request(botId: string, requestActor: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request("http://localhost/rpc/bots/getWebhookConfig", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId } }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    return response!;
  }
  return { request, findBot, findSecret, load };
}

it("reveals the existing key only through an authenticated owner read", async () => {
  const h = harness();
  const response = await h.request("owned");
  expect(response.status).toBe(200);
  expect((await response.json()).json).toEqual({
    secret: "existing-key",
    path: "/api/v1/bots/owned/webhook",
    webhookConfigured: true,
  });
  expect(h.findBot.mock.calls[0]![0]).toMatchObject({
    where: { id: "owned", spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
  });
  expect(h.findSecret).toHaveBeenCalledWith({
    where: { id: "secret-id", spaceId: actor.spaceId, userId: actor.userId, kind: "webhook" },
  });
  expect(h.load).toHaveBeenCalledWith("cipher", "secret-id");
});
it("does not decrypt for unauthenticated or unowned bots", async () => {
  const h = harness();
  expect((await h.request("owned", null)).status).toBe(401);
  expect((await h.request("unowned")).status).not.toBe(200);
  expect(h.findSecret).not.toHaveBeenCalled();
  expect(h.load).not.toHaveBeenCalled();
});
it("returns no configuration when the secret record is missing", async () => {
  const h = harness();
  h.findSecret.mockResolvedValue(null as never);
  const response = await h.request("owned");
  expect(response.status).toBe(200);
  expect((await response.json()).json).toBeNull();
  expect(h.load).not.toHaveBeenCalled();
});
