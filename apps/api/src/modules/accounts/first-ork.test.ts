// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor, Bot } from "@orkbot/contracts";
import { seededLogoAvatarColor } from "@orkbot/core";
import type { createRepos, PrismaClient } from "@orkbot/db";
import { FirstBotAlreadyExistsError } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { ensureFirstOrk, syncPrimaryOrk } from "./first-ork.js";

const seed = "a0d0b468-5630-49c2-977e-79c19917c61b";
const actor: Actor = {
  userId: "user-one",
  spaceId: "personal",
  email: "member@example.test",
  isDeploymentOwner: false,
};
function fixture(existing: { id: string; avatarSeed: string | null } | null = null) {
  const bot = { id: existing?.id ?? "created", name: existing ? "My chosen name" : "Chief" } as Bot;
  const prisma = {
    space: { findFirst: vi.fn(async () => ({ id: "personal" }) as { id: string } | null) },
    user: { findUniqueOrThrow: vi.fn(async () => ({ orkAvatar: seed as string | null })) },
    bot: {
      findFirst: vi.fn(async () =>
        existing
          ? {
              ...existing,
              color: seededLogoAvatarColor(existing.id),
              fleetManagement: Boolean(existing.avatarSeed),
            }
          : null,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const repos = {
    createBot: vi.fn(async (_actor: Actor, _input: Record<string, unknown>) => bot),
    listBots: vi.fn(async (_actor: Actor) => [bot]),
  };
  const ensure = (ready = true) =>
    ensureFirstOrk(
      prisma as unknown as PrismaClient,
      repos as unknown as Pick<ReturnType<typeof createRepos>, "createBot" | "listBots">,
      actor,
      ready,
    );
  return { prisma, repos, ensure, bot };
}

describe("the account's primary Ork", () => {
  it("requires completed setup before reading or creating anything", async () => {
    const f = fixture();
    expect(await f.ensure(false)).toBeNull();
    expect(f.prisma.space.findFirst).not.toHaveBeenCalled();
    expect(f.repos.createBot).not.toHaveBeenCalled();
  });
  it("uses the saved account seed and enables fleet management", async () => {
    const f = fixture();
    expect(await f.ensure()).toBe(f.bot);
    expect(f.repos.createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        name: "Chief",
        avatarSeed: seed,
        color: seededLogoAvatarColor(seed),
        fleetManagement: true,
        firstForAccount: true,
        spawnKey: `onboarding:first:${actor.userId}`,
      }),
    );
    expect(f.prisma.space.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: actor.spaceId,
          isDefault: true,
          organization: { slug: `user-${actor.userId}` },
        },
      }),
    );
  });
  it("does not create a bot in another empty Space", async () => {
    const f = fixture();
    f.prisma.space.findFirst.mockResolvedValue(null);
    expect(await f.ensure()).toBeNull();
    expect(f.repos.createBot).not.toHaveBeenCalled();
  });
  it("adopts a legacy primary without renaming it or replacing its id", async () => {
    const f = fixture({ id: "legacy", avatarSeed: null });
    expect(await f.ensure()).toBe(f.bot);
    expect(f.prisma.bot.updateMany).toHaveBeenCalledWith({
      where: {
        id: "legacy",
        userId: actor.userId,
        spaceId: actor.spaceId,
        avatarSeed: null,
        color: seededLogoAvatarColor("legacy"),
      },
      data: { avatarSeed: seed, color: seededLogoAvatarColor(seed), fleetManagement: true },
    });
    expect(f.repos.listBots).toHaveBeenCalledWith(actor);
    expect(f.repos.createBot).not.toHaveBeenCalled();
  });
  it("leaves an already assigned Ork unchanged on repeat visits", async () => {
    const f = fixture({ id: "primary", avatarSeed: seed });
    await f.ensure();
    expect(f.prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(f.repos.createBot).not.toHaveBeenCalled();
  });
  it("reuses the winner after concurrent creation and does not return unrelated content", async () => {
    const f = fixture();
    f.bot.id = "winner";
    f.repos.createBot.mockRejectedValue(new FirstBotAlreadyExistsError());
    f.prisma.bot.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "winner",
      avatarSeed: seed,
      color: seededLogoAvatarColor(seed),
      fleetManagement: true,
    });
    expect(await f.ensure()).toBe(f.bot);
    expect(f.repos.listBots).toHaveBeenCalledWith(actor);
    f.prisma.bot.findFirst.mockResolvedValue(null);
    expect(await f.ensure()).toBeNull();
  });
  it("ignores malformed claims and propagates real creation failures", async () => {
    const f = fixture();
    f.prisma.user.findUniqueOrThrow.mockResolvedValue({ orkAvatar: "not-an-identity" });
    await f.ensure();
    expect(f.repos.createBot.mock.calls[0]?.[1]).not.toHaveProperty("avatarSeed");
    f.repos.createBot.mockRejectedValue(new Error("storage failed"));
    await expect(f.ensure()).rejects.toThrow("storage failed");
  });
});

describe("existing primary adoption", () => {
  const wrap = (prisma: unknown) => prisma as PrismaClient;
  it.each(["data:image/png;base64,aGVsbG8=", "#123456::shape_3"])(
    "preserves explicit appearance %s and marks adoption once",
    async (color) => {
      const f = fixture();
      f.prisma.bot.findFirst.mockResolvedValue({
        id: "legacy",
        avatarSeed: null,
        color,
        fleetManagement: false,
      });
      await syncPrimaryOrk(wrap(f.prisma), actor, seed);
      expect(f.prisma.bot.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { avatarSeed: seed, fleetManagement: true } }),
      );
    },
  );
  it("retains an explicit colour while adopting the saved account shape", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValue({
      id: "legacy",
      avatarSeed: null,
      color: "#123456",
      fleetManagement: false,
    });
    await syncPrimaryOrk(wrap(f.prisma), actor, seed);
    expect(f.prisma.bot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { avatarSeed: seed, color: "#123456", fleetManagement: true },
      }),
    );
  });
  it("does not re-enable fleet management after an explicit owner choice", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValue({
      id: "primary",
      avatarSeed: seed,
      color: "#123456",
      fleetManagement: false,
    });
    await syncPrimaryOrk(wrap(f.prisma), actor, seed);
    expect(f.prisma.bot.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.userId,
          spaceId: actor.spaceId,
          avatarSeed: null,
        }),
      }),
    );
  });
});
