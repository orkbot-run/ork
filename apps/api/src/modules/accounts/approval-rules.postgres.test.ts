// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import type { Actor } from "@orkbot/contracts";
import { asSystem, bootstrapUserSpace, createDb, setSpaceSettingOverride } from "@orkbot/db";
import { createRouterClient } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

describePostgres("approval rule mode validation (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  async function fixture(accountNever = false, spaceNever = false) {
    const system = asSystem(db.prisma);
    const id = randomUUID();
    const email = `${id}@example.test`;
    await system.user.create({ data: { id, name: "Rule owner", email, emailVerified: false } });
    const { spaceId } = await bootstrapUserSpace(
      system,
      { id },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    const actor: Actor = { userId: id, spaceId, email, isDeploymentOwner: false };
    await system.userActionAutoReviewPreference.create({
      data: { userId: id, enabled: false, skipApprovals: accountNever },
    });
    await setSpaceSettingOverride(system, actor, "confirmations", true);
    await system.actionAutoReviewPreference.update({
      where: { spaceId_userId: { spaceId, userId: id } },
      data: { skipApprovals: spaceNever, enabled: false },
    });
    const client = createRouterClient(
      createRouter({ prisma: db.prisma, env: {} } as unknown as RouterDeps),
      { context: { actor } },
    );
    return { system, client, actor };
  }

  it.each(["shell", "write_file"])(
    "honors an account Ask for %s even when the selected Space never asks",
    async (name) => {
      const { client, system, actor } = await fixture(false, true);
      await expect(
        client.approvalRules.set({
          scope: "account",
          effect: "require_approval",
          matchKind: "tool",
          matchValue: name,
        }),
      ).resolves.toMatchObject({ matchValue: name, effect: "require_approval" });
      await expect(
        client.approvalRules.set({
          scope: "space",
          effect: "require_approval",
          matchKind: "tool",
          matchValue: name,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await system.userActionApprovalRule.count({ where: { userId: actor.userId } })).toBe(
        1,
      );
      expect(await system.actionApprovalRule.count({ where: { spaceId: actor.spaceId } })).toBe(0);
    },
  );

  it("uses the Space mode when the account never asks", async () => {
    const { client } = await fixture(true, false);
    await expect(
      client.approvalRules.set({
        scope: "space",
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "write_file",
      }),
    ).resolves.toMatchObject({ effect: "require_approval" });
    await expect(
      client.approvalRules.set({
        scope: "account",
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "write_file",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a stale form after its mode changed without partially saving a rule", async () => {
    const { client, system, actor } = await fixture();
    await system.userActionAutoReviewPreference.update({
      where: { userId: actor.userId },
      data: { skipApprovals: true },
    });
    await expect(
      client.approvalRules.set({
        scope: "account",
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "write_file",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await system.userActionApprovalRule.count({ where: { userId: actor.userId } })).toBe(0);
  });

  it("refuses ineffective host and mandatory tool choices while retaining integration/site compatibility", async () => {
    const { client } = await fixture();
    for (const [name, effect] of [
      ["user_computer_shell", "always_allow"],
      ["user_computer_act", "require_approval"],
      ["create_space", "always_allow"],
      ["read_file", "require_approval"],
      ["web_fetch", "require_approval"],
    ] as const)
      await expect(
        client.approvalRules.set({ scope: "account", effect, matchKind: "tool", matchValue: name }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.approvalRules.set({
        scope: "account",
        effect: "deny",
        matchKind: "tool",
        matchValue: "user_computer_shell",
      }),
    ).resolves.toMatchObject({ effect: "deny" });
    await expect(
      client.approvalRules.set({
        scope: "account",
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "mcp__notes__write",
      }),
    ).resolves.toMatchObject({ matchValue: "mcp__notes__write" });
    await expect(
      client.approvalRules.set({
        scope: "account",
        effect: "always_allow",
        matchKind: "site",
        matchValue: "example.test",
      }),
    ).resolves.toMatchObject({ matchValue: "example.test" });
  });
});
