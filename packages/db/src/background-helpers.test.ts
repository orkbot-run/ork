// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { expect, it, vi } from "vitest";
import { returnBackgroundHelperOutcome } from "./background-helpers.js";
import type { PrismaClient } from "./client.js";

it.each([
  ["the helper run was removed", null],
  ["the helper thread disappeared during relation loading", { thread: null }],
])("ignores a late helper outcome when %s", async (_description, candidate) => {
  const findFirst = vi.fn(async () => candidate);
  const queryRaw = vi.fn();
  // Prisma can hydrate a missing relation after the run query saw the row.
  // No lock or write is permitted once that helper-to-parent link is gone.
  const transaction = { run: { findFirst }, $queryRaw: queryRaw };
  const prisma = {
    $transaction: async (work: (tx: typeof transaction) => Promise<unknown>) => work(transaction),
  } as unknown as PrismaClient;

  await expect(
    returnBackgroundHelperOutcome(prisma, { spaceId: "space-a", runId: "helper-run" }),
  ).resolves.toBeNull();
  expect(findFirst).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      where: expect.objectContaining({ id: "helper-run", spaceId: "space-a" }),
    }),
  );
  expect(queryRaw).not.toHaveBeenCalled();
});
