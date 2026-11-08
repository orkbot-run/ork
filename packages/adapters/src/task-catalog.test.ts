// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors (inherited material)
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 tests are preserved; cross-chat routine regressions are Ork additions.

import { describe, expect, it, vi } from "vitest";
import { listSchedulesFromTool } from "./schedule-tools.js";
import { TASK_CATALOG_GUIDANCE, taskCatalogFromTool } from "./task-catalog.js";

describe("task catalog", () => {
  it("returns the bot's real work records and exposed tool roster", async () => {
    const prisma = {
      scratchpadItem: {
        findMany: vi.fn(async () => [
          {
            id: "item-1",
            botId: "bot-1",
            title: "Check the inbox",
            status: "open",
            notes: "Use the connected mail tool.",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ]),
      },
      routine: {
        findMany: vi.fn(async () => [
          {
            id: "routine-1",
            name: "Morning report",
            prompt: "Read the report and summarize it.",
            crons: ["0 9 * * *"],
            active: true,
            nextRunAt: new Date("2026-01-03T09:00:00.000Z"),
          },
        ]),
      },
      taughtSkill: {
        findMany: vi.fn(async (_args: Record<string, unknown>) => [
          { id: "taught-1", name: "Export report", goal: "Export the report", status: "saved" },
        ]),
      },
      agentSkill: {
        findMany: vi.fn(async () => [
          {
            id: "skill-1",
            name: "Daily report",
            description: "Build the daily report",
            content: "steps",
            source: "user",
          },
        ]),
      },
    };

    const result = await taskCatalogFromTool(
      { prisma: prisma as never },
      {
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        tools: [
          { name: "task_catalog", description: "Catalog", readOnly: true },
          { name: "task_catalog", description: "Duplicate", readOnly: true },
          { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
        ],
      },
    );

    expect(result.tasks).toEqual([
      expect.objectContaining({ id: "item-1", title: "Check the inbox", source: "scratchpad" }),
    ]);
    expect(result.routines).toEqual([
      expect.objectContaining({ routineId: "routine-1", name: "Morning report", active: true }),
    ]);
    expect(result.taughtSkills).toEqual([
      {
        id: "taught-1",
        name: "Export report",
        goal: "Export the report",
        status: "saved",
        source: "taught_skill",
      },
    ]);
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          botId: "bot-1",
          status: "saved",
        },
      }),
    );
    expect(prisma.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ userId: expect.anything() }),
      }),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Daily report", source: "user", readOnly: false }),
      ]),
    );
    expect(result.tools).toEqual([
      { name: "task_catalog", description: "Catalog", readOnly: true },
      { name: "GITHUB_LIST_RELEASES", description: "List releases", readOnly: true },
    ]);
    expect(result.guidance).toBe(TASK_CATALOG_GUIDANCE);
  });
});

it("shares the bot-wide group routine projection with schedule_list", async () => {
  const findMany = vi.fn(async () =>
    ["current", "other", null].map((threadId, i) => ({
      id: `routine-${i}`,
      threadId,
      name: "Daily",
      prompt: "Check",
      crons: ["0 9 * * *"],
      active: true,
      timezone: "UTC",
      nextRunAt: null,
    })),
  );
  const deps = {
    prisma: {
      routine: { findMany },
      scratchpadItem: { findMany: async () => [] },
      taughtSkill: { findMany: async () => [] },
      agentSkill: { findMany: async () => [] },
    },
  } as unknown as Parameters<typeof taskCatalogFromTool>[0];
  const input = { spaceId: "space-1", botId: "bot-1", userId: "user-1", threadId: "current" };
  const schedules = await listSchedulesFromTool(deps, input);
  const catalog = await taskCatalogFromTool(deps, { ...input, tools: [] });
  expect(catalog.routines).toEqual(schedules.routines);
  expect(catalog.routines.map((row) => row.inThisChat)).toEqual([true, false, false]);
  expect(findMany).toHaveBeenLastCalledWith({
    where: { spaceId: "space-1", botId: "bot-1", userId: "user-1" },
    orderBy: { createdAt: "desc" },
  });
});
