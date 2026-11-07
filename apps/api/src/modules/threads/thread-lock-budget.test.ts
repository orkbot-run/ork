// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import { createRouterClient } from "@orpc/server";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

it("budgets a group follow-up after resolving the owned target", async () => {
  const failure = new Error("fixture transaction body is not entered");
  const $transaction = vi.fn().mockRejectedValue(failure);
  const actor: Actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "user@example.test",
    isDeploymentOwner: false,
  };
  const findFirst = vi.fn(async () => ({
    id: "group-1",
    name: "Group",
    thread: { id: "thread-1" },
    members: ["bot-1", "bot-2"].map((id) => ({
      bot: { id, name: id, color: "blue", avatarSet: "default", runs: [] },
    })),
  }));
  const deps = {
    prisma: { chatGroup: { findFirst }, $transaction },
    env: { agentRuntime: "scripted" },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  await expect(client.threads.followUp({ groupId: "group-1", text: "Continue" })).rejects.toBe(
    failure,
  );
  expect(findFirst).toHaveBeenCalledOnce();
  expect($transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20_000 });
});
