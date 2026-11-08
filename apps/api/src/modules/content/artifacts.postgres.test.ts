// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved; attachment-label and replay-boundary regressions are Ork additions.

import type { ArtifactStore } from "@orkbot/adapter-kit";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { asSystem, createDb, IsolationError, runAsTenant } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOwnedArtifact, storeInboundAttachment } from "./artifacts.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("artifact upload nonce (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `artifact-nonce-user-${suffix}`;
  const organizationId = `artifact-nonce-org-${suffix}`;
  const spaceId = `artifact-nonce-space-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@orkbot.test`,
    isDeploymentOwner: false,
  };
  const stored = new Set<string>();
  let puts = 0;
  const artifacts = {
    async put() {
      puts += 1;
      const id = `blob-${puts}`;
      stored.add(id);
      return { id };
    },
    async remove(id: string) {
      stored.delete(id);
    },
  } as unknown as ArtifactStore;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let otherBotId: string;
  const upload = (clientNonce: string | undefined, target: { botId: string; groupId?: string }) =>
    runAsTenant(actor, () =>
      createOwnedArtifact({ prisma, artifacts }, actor, {
        ...target,
        name: "notes.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("hello").toString("base64"),
        clientNonce,
      }),
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await system.user.create({
      data: { id: userId, name: userId, email: `${userId}@orkbot.test`, emailVerified: false },
    });
    await system.organization.create({
      data: { id: organizationId, name: "Nonce Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    botId = (await system.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
    otherBotId = (
      await system.bot.create({ data: { spaceId, userId, name: "Scout", color: "green" } })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: userId } });
    await close();
  });

  it("returns the artifact a retried upload already created", async () => {
    const first = await upload("send-1:0", { botId });
    const retry = await upload("send-1:0", { botId });
    expect(retry).toEqual(first);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-1:0" } })).toBe(1);
    expect(stored.size).toBe(1);
  });

  it("creates one artifact when two retries of an upload race", async () => {
    const [a, b] = await Promise.all([
      upload("send-2:0", { botId }),
      upload("send-2:0", { botId }),
    ]);
    expect(a.id).toBe(b.id);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-2:0" } })).toBe(1);
    expect(stored.size).toBe(2);
  });

  it("replays one artifact when retries of a group upload race under different member bots", async () => {
    const group = await system.chatGroup.create({ data: { spaceId, userId, name: "Race" } });
    const uploads = await Promise.all(
      [botId, otherBotId, botId, otherBotId].map((member) =>
        upload("send-5:0", { botId: member, groupId: group.id }),
      ),
    );
    expect(new Set(uploads.map((artifact) => artifact.id)).size).toBe(1);
    expect(await system.artifact.count({ where: { spaceId, clientNonce: "send-5:0" } })).toBe(1);
  });

  it("refuses a nonce reused for another chat", async () => {
    await upload("send-3:0", { botId });
    await expect(upload("send-3:0", { botId: otherBotId })).rejects.toBeInstanceOf(IsolationError);
  });
  it("persists download MIME and replays an image without metadata resolution or resource access", async () => {
    const nonce = "inbound-image:0";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetch = vi.fn(async () => ({ bytes, mimeType: "image/png" }));
    const deliver = () =>
      runAsTenant(actor, () =>
        storeInboundAttachment({ prisma, artifacts }, actor, {
          botId,
          clientNonce: nonce,
          attachment: { name: "image-1", mimeType: "", fetch },
        }),
      );
    const first = await deliver();
    expect(first).toMatchObject({
      name: "image-1",
      mimeType: "image/png",
      size: bytes.length,
      bytes,
    });
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockRejectedValue(new Error("resource no longer exists"));
    const replayed = await deliver();
    expect(replayed.id).toBe(first.id);
    expect(replayed).not.toHaveProperty("bytes");
    expect(fetch).toHaveBeenCalledOnce();
    const row = await system.artifact.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({ userId, spaceId, botId, name: "image-1", mimeType: "image/png" });
    expect(await system.artifact.count({ where: { userId, spaceId, clientNonce: nonce } })).toBe(1);
  });

  it("reuses an inbound artifact before expired deadline or changed metadata and rejects retarget before fetch", async () => {
    const nonce = "inbound-expired:0";
    const stored = await upload(nonce, { botId });
    const putsBefore = puts;
    const fetch = vi.fn(async () => new Uint8Array([1]));
    const attachment = {
      name: "changed.exe",
      mimeType: "application/x-msdownload",
      size: Number.MAX_SAFE_INTEGER,
      fetch,
    };
    const deliver = (targetBot: string, clientNonce = nonce) =>
      runAsTenant(actor, () =>
        storeInboundAttachment({ prisma, artifacts }, actor, {
          botId: targetBot,
          clientNonce,
          attachment,
          downloadDeadline: Date.now() - 1,
        }),
      );
    const replayed = await deliver(botId);
    expect(replayed).toEqual(stored);
    expect(replayed).not.toHaveProperty("bytes");
    await expect(deliver(otherBotId)).rejects.toBeInstanceOf(IsolationError);
    // A fresh supported attachment after the same deadline must fail without fetching.
    await expect(
      runAsTenant(actor, () =>
        storeInboundAttachment({ prisma, artifacts }, actor, {
          botId,
          clientNonce: "inbound-missing:0",
          attachment: { name: "fresh.txt", mimeType: "text/plain", fetch },
          downloadDeadline: Date.now() - 1,
        }),
      ),
    ).rejects.toThrow("Attachment download timed out");
    expect(fetch).not.toHaveBeenCalled();
    expect(puts).toBe(putsBefore);
    expect(await system.artifact.count({ where: { spaceId, userId, clientNonce: nonce } })).toBe(1);
    expect(
      await system.artifact.count({ where: { spaceId, userId, clientNonce: "inbound-missing:0" } }),
    ).toBe(0);
  });
});
