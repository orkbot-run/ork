// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { UsageBreakdownInput } from "@orkbot/contracts";
import { UsageBreakdownSchema } from "@orkbot/contracts";
import { asSystem, createDb, runAsTenant } from "@orkbot/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadUsageBreakdown } from "./usage-breakdown.js";

const postgres = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;
const now = new Date("2026-03-09T06:30:00.000Z");

postgres("usage breakdown follows the signed-in member's local calendar", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `usage-org-${suffix}`;
  const owner = { userId: `usage-owner-${suffix}`, spaceId: `usage-space-${suffix}` };
  const peer = { ...owner, userId: `usage-peer-${suffix}` };
  const otherSpace = { ...owner, spaceId: `usage-other-space-${suffix}` };
  const botId = `usage-bot-${suffix}`;
  const deletedBotId = `removed-bot-${suffix}`;
  const unknownBotId = `unknown-bot-${suffix}`;
  let db: ReturnType<typeof createDb>;

  function call(
    date: string,
    args: Partial<{
      botId: string | null;
      provider: string;
      model: string;
      runId: string;
      parentRunId: string;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      costUsd: number | null;
    }> = {},
  ) {
    return {
      ...owner,
      botId,
      provider: "beta",
      model: "historic",
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      costUsd: 0.02,
      createdAt: new Date(date),
      ...args,
    };
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const prisma = asSystem(db.prisma);
    await prisma.organization.create({
      data: { id: organizationId, name: "Usage fixture", slug: organizationId, createdAt: now },
    });
    for (const scope of [owner, otherSpace]) {
      await prisma.space.create({
        data: { id: scope.spaceId, organizationId, name: scope.spaceId },
      });
    }
    for (const [scope, timezone] of [
      [owner, "America/Los_Angeles"],
      [peer, "Invalid/Legacy"],
    ] as const) {
      await prisma.user.create({
        data: {
          id: scope.userId,
          name: scope.userId,
          email: `${scope.userId}@example.test`,
          timezone,
        },
      });
    }
    await prisma.bot.create({
      data: { id: botId, ...owner, name: "Research", color: "purple" },
    });
    await prisma.botDeletion.create({
      data: {
        id: deletedBotId,
        spaceId: owner.spaceId,
        name: "Archived helper",
        deletedByUserId: owner.userId,
        memoriesPreserved: true,
      },
    });
    await prisma.usageRecord.createMany({
      data: [
        call("2025-12-15T00:00:00.000Z", { botId: unknownBotId, runId: "oldest" }),
        call("2026-02-07T07:59:59.999Z", { runId: "outside-30" }),
        call("2026-02-07T08:00:00.000Z", { botId: null, runId: "start-30" }),
        call("2026-03-02T07:59:59.999Z", { runId: "outside-7" }),
        call("2026-03-02T08:00:00.000Z", { runId: "start-7" }),
        call("2026-03-08T07:59:59.999Z", { runId: "prior-local-day" }),
        call("2026-03-08T08:00:00.000Z", {
          provider: "alpha",
          model: "shared",
          runId: "parent",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          costUsd: 0.4,
        }),
        call("2026-03-08T09:00:00.000Z", {
          provider: "beta",
          model: "shared",
          runId: "helper",
          parentRunId: "parent",
          inputTokens: 10,
          outputTokens: null,
          totalTokens: null,
          costUsd: null,
        }),
        call("2026-03-09T06:30:00.000Z", {
          botId: deletedBotId,
          provider: "alpha",
          model: "shared",
          runId: "second",
          inputTokens: 30,
          outputTokens: 5,
          totalTokens: 35,
          costUsd: 0.1,
        }),
        call("2026-03-09T06:30:00.001Z", { model: "future", runId: "future" }),
        {
          ...call("2026-03-08T09:30:00.000Z", { model: "private-peer", inputTokens: 888 }),
          ...peer,
        },
        {
          ...call("2026-03-08T09:30:00.000Z", { model: "another-space", inputTokens: 999 }),
          ...otherSpace,
        },
      ],
    });
  });

  afterAll(async () => {
    if (!db) return;
    const prisma = asSystem(db.prisma);
    await prisma.usageRecord.deleteMany({
      where: { spaceId: { in: [owner.spaceId, otherSpace.spaceId] } },
    });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.userId, peer.userId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function query(input: UsageBreakdownInput, actor = owner) {
    const result = await runAsTenant(actor, () => loadUsageBreakdown(db.prisma, actor, input, now));
    return UsageBreakdownSchema.parse(result);
  }

  it.each([
    ["today", "2026-03-08", 3],
    ["7d", "2026-03-02", 5],
    ["30d", "2026-02-07", 7],
    ["all", "2025-12-14", 9],
  ] as const)(
    "includes the exact %s boundary and excludes calls later than now",
    async (range, from, calls) => {
      const result = await query({ range });
      expect(result).toMatchObject({
        timezone: "America/Los_Angeles",
        from,
        to: "2026-03-08",
        totals: { modelCalls: calls },
        overTimeUnit: range === "all" ? "month" : "day",
      });
      expect(result.overTime[0]?.date).toBe(range === "all" ? "2025-12-01" : from);
      expect(result.overTime.at(-1)?.date).toBe(range === "all" ? "2026-03-01" : "2026-03-08");
      expect(result.modelOptions.some((entry) => entry.model === "future")).toBe(false);
      expect(result.overTime.reduce((sum, bucket) => sum + bucket.modelCalls, 0)).toBe(calls);
      if (range === "7d") expect(result.overTime[1]).toMatchObject({ modelCalls: 0, costUsd: 0 });
    },
  );

  it("keeps partial totals unknown and counts a parent run and its helper as one run", async () => {
    const result = await query({ range: "today" });
    const expected = {
      runs: 2,
      modelCalls: 3,
      inputTokens: 140,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    };
    expect(result.totals).toEqual(expected);
    expect(result.overTime).toEqual([{ date: "2026-03-08", ...expected }]);
    expect(result.bots).toEqual([
      expect.objectContaining({ botId, name: "Research", deleted: false, runs: 1, modelCalls: 2 }),
      expect.objectContaining({
        botId: deletedBotId,
        name: "Archived helper",
        deleted: true,
        costUsd: 0.1,
      }),
    ]);
    expect((await query({ range: "all" })).botOptions).toContainEqual({
      botId: unknownBotId,
      name: null,
      deleted: true,
    });
  });

  it("applies the pair of model and provider and the bot to every aggregation", async () => {
    const filtered = await query({ range: "today", botId, provider: "alpha", model: "shared" });
    const expected = {
      runs: 1,
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.4,
    };
    expect(filtered.totals).toEqual(expected);
    expect(filtered.bots).toEqual([{ botId, name: "Research", deleted: false, ...expected }]);
    expect(filtered.models).toEqual([{ provider: "alpha", model: "shared", ...expected }]);
    expect(filtered.overTime).toEqual([{ date: "2026-03-08", ...expected }]);
    expect(filtered.botOptions).toHaveLength(2);
    expect(filtered.modelOptions).toEqual([
      { provider: "alpha", model: "shared" },
      { provider: "beta", model: "shared" },
    ]);
    const noMatch = await query({ range: "today", model: "historic" });
    expect(noMatch.totals).toMatchObject({ modelCalls: 0, costUsd: 0 });
    expect(noMatch.models).toEqual([]);
    expect(noMatch.modelOptions).toEqual(filtered.modelOptions);
  });

  it("excludes a peer's usage and another Space and safely falls back from invalid IANA data", async () => {
    const result = await query({ range: "all" });
    expect(result.modelOptions.map(({ model }) => model)).not.toContain("private-peer");
    expect(result.modelOptions.map(({ model }) => model)).not.toContain("another-space");
    const own = await query({ range: "all" }, peer);
    expect(own).toMatchObject({
      timezone: "UTC",
      to: "2026-03-09",
      totals: { modelCalls: 1, inputTokens: 888 },
      modelOptions: [{ provider: "beta", model: "private-peer" }],
    });
    // Even a usage row with the other owner's id cannot resolve that other bot's private name.
    expect(own.botOptions[0]?.name).toBeNull();
  });
});
