// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { asSystem, createDb, provisionMessagingIdentity, runAsTenant } from "@orkbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const url = process.env.DATABASE_URL;
const postgres = process.env.VERIFY_DATABASE && url ? describe.sequential : describe.skip;
postgres("direct delivery review RPC (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let actor: Actor;
  let identityId: string;
  let outboundId: string;
  let handler: RPCHandler<{ actor: Actor }>;
  const enqueue = vi.fn(async () => undefined);
  beforeAll(() => {
    db = createDb(url!);
    system = asSystem(db.prisma);
  });
  afterAll(async () => {
    await db.prisma.$disconnect();
    await db.pool.end();
  });
  beforeEach(async () => {
    enqueue.mockClear();
    const identity = await provisionMessagingIdentity(
      system,
      { provider: "telegram", address: `review-${randomUUID()}` },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    actor = { ...identity, email: "fixture@example.test", isDeploymentOwner: false };
    identityId = (
      await system.messagingIdentity.findUniqueOrThrow({ where: { botId: identity.botId } })
    ).id;
    const source = await system.message.create({
      data: {
        threadId: identity.threadId,
        botId: identity.botId,
        role: "bot",
        seq: 900,
        blocks: [{ kind: "text", text: "Bounded delivery preview" }],
      },
    });
    outboundId = (
      await system.messagingOutbound.create({
        data: {
          kind: "dm",
          identityId,
          body: "Bounded delivery preview",
          status: "uncertain",
          requiredDeliveryVersion: 1,
          sourceMessageId: source.id,
          idempotencyKey: `review:${randomUUID()}`,
        },
      })
    ).id;
    handler = new RPCHandler(
      createRouter({
        prisma: db.prisma,
        jobs: { enqueue },
        env: {},
        messaging: { enabled: true, providers: [], addresses: {}, openSignup: false },
      } as unknown as RouterDeps),
    );
  });
  async function call(path: string, body: unknown, caller = actor) {
    const { response } = await runAsTenant(caller, () =>
      handler.handle(
        new Request(`http://127.0.0.1/rpc/messaging/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ json: body }),
        }),
        { prefix: "/rpc", context: { actor: caller } },
      ),
    );
    if (!response) throw new Error("Missing RPC response");
    return response;
  }
  async function listed() {
    const response = await call("outbound/list", { identityId });
    expect(response.status).toBe(200);
    return (await response.json()).json as {
      items: Array<{ id: string; version: string; preview: string }>;
      hasMore: boolean;
    };
  }
  it("returns contextual count, scoped preview and an idempotent terminal decision without resending", async () => {
    const status = await call("status", {});
    expect(status.status).toBe(200);
    expect((await status.json()).json.identities[0].deliveryReview).toEqual({
      spaceId: actor.spaceId,
      count: 1,
    });
    const list = await listed();
    expect(list.hasMore).toBe(false);
    expect(list.items).toEqual([
      expect.objectContaining({
        id: outboundId,
        preview: "Bounded delivery preview",
        version: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    const input = {
      identityId,
      outboundId,
      version: list.items[0]!.version,
      resolution: "confirmed_not_sent",
    };
    expect((await call("outbound/resolve", input)).status).toBe(200);
    expect((await call("outbound/resolve", input)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "messaging.deliver", payload: {} }),
    );
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: outboundId } })).status,
    ).toBe("resolved_not_sent");
    expect((await listed()).items).toEqual([]);
  });
  it("rejects foreign actors, wrong Spaces, stale versions and malformed intents without a wake", async () => {
    const version = (await listed()).items[0]!.version;
    expect(
      (await call("outbound/list", { identityId }, { ...actor, userId: "foreign-user" })).status,
    ).toBe(404);
    expect(
      (
        await call(
          "outbound/resolve",
          { identityId, outboundId, version, resolution: "confirmed_sent" },
          { ...actor, spaceId: "foreign-space" },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call("outbound/resolve", {
          identityId,
          outboundId,
          version: "0".repeat(64),
          resolution: "confirmed_sent",
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("outbound/resolve", { identityId, outboundId, version, resolution: "resend" }))
        .status,
    ).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: outboundId } })).status,
    ).toBe("uncertain");
  });
  it("commits resolution even when the best-effort drain wake fails", async () => {
    const version = (await listed()).items[0]!.version;
    enqueue.mockRejectedValueOnce(new Error("fixture queue unavailable"));
    expect(
      (
        await call("outbound/resolve", {
          identityId,
          outboundId,
          version,
          resolution: "confirmed_sent",
        })
      ).status,
    ).toBe(200);
    expect(
      (await system.messagingOutbound.findUniqueOrThrow({ where: { id: outboundId } })).status,
    ).toBe("resolved_sent");
  });
});
