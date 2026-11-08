// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors. Inherited Apache material and new PolyForm changes.

import { describe, expect, it, vi } from "vitest";
import type { OwnBotSettingsRow } from "./own-bot-settings.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

function ownBotUpdateCall() {
  const live: OwnBotSettingsRow = {
    name: "Scout",
    description: "Finds papers",
    instructions: "Cite sources.",
    color: "blue",
    notifyOnFinish: false,
    dailyCheckIns: false,
    modelProvider: "provider-a",
    modelId: "model-1",
    thinkingLevel: null,
    autoSpeak: false,
    voiceId: null,
  };
  const defaults = {
    defaultModelProvider: "provider-a",
    defaultModelId: "fresh-default",
    modelCreditsEnabled: false,
  };
  const ctx = {
    deps: {
      prisma: {
        bot: {
          findUnique: async () => ({ fleetManagement: true }),
          findUniqueOrThrow: vi.fn(async () => live),
        },
        deploymentSettings: { findUnique: vi.fn(async () => defaults) },
        spaceSettingOverride: { findUnique: async () => null },
        userModelRoleChoice: { findMany: async () => [] },
      },
    },
    run: { trigger: "user", threadId: "thread-1", userId: "user-1", spaceId: "space-1" },
    bot: { id: "bot-1" },
    source: { ownerStartedRun: true },
    state: {
      tainted: true,
      earlierAttempt: Promise.resolve(false),
      ownInstructionsBaseline: live.instructions,
    },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
      receivedOutsideMessage: async () => false,
    },
    secrets: [],
  };
  const request: ToolRequest = {
    name: "update_bot",
    args: { model: "test-model" },
    executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
    connectorCall: {
      tool: "update_bot",
      args: { model: "test-model" },
      executionId: JSON.stringify(["pi-tool", "main", "call-1"]),
      route: undefined,
    },
    effectRequest: { model: "test-model" },
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "update_bot",
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
  };
  return { ctx, live, defaults, request: () => structuredClone(request) };
}

describe("prepareToolRequest: update_bot owner settings after outside content", () => {
  it("refuses once, then ends the turn instead of repeating the refusal", async () => {
    const { ctx, request } = ownBotUpdateCall();
    await expect(prepareToolRequest(ctx as never, request())).resolves.toEqual({
      error: expect.stringContaining("outside content"),
    });
    const repeat = await prepareToolRequest(ctx as never, request());
    expect(repeat).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining("Settings"),
        },
      ],
    });
    expect(JSON.stringify(repeat)).not.toContain("outside content");
  });

  it("keeps preparing the change while the run is untainted", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.state.tainted = false;
    for (let index = 0; index < 3; index += 1) {
      await expect(prepareToolRequest(ctx as never, request())).resolves.toBeUndefined();
    }
  });
});

describe("prepareToolRequest: unchanged own settings and paging", () => {
  it("treats the exact caller id as its own paging target with management disabled", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.deps.prisma.bot.findUnique = async () => ({ fleetManagement: false });
    ctx.source.ownerStartedRun = false;
    const call = request();
    call.args = { bot_id: ctx.bot.id, instructions_offset: 8000, model: "other/model" };
    await expect(prepareToolRequest(ctx as never, call)).resolves.toBeUndefined();
    expect(call.args).toEqual({ instructions_offset: 8000, model: "other/model" });
    expect(call.effectRequest).toEqual(call.args);
    expect(ctx.deps.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it.each(["other-bot", " bot-1 ", 1])(
    "keeps non-exact target %s behind fleet permissions",
    async (bot_id) => {
      const { ctx, request } = ownBotUpdateCall();
      ctx.deps.prisma.bot.findUnique = async () => ({ fleetManagement: false });
      const call = request();
      call.args = { bot_id, instructions_offset: 8000 };
      await expect(prepareToolRequest(ctx as never, call)).resolves.toEqual({
        error: "This tool is disabled for this bot.",
      });
    },
  );

  it("allows an echoed settings read after outside content without requiring approval", async () => {
    const { ctx, live, request } = ownBotUpdateCall();
    ctx.source.ownerStartedRun = false;
    const call = request();
    call.args = {
      name: live.name,
      instructions: live.instructions,
      model: "provider-a/model-1",
      notifyOnFinish: "false",
      dailyCheckIns: false,
      readAloud: "false",
      thinkingLevel: "default",
      voice: "default",
      instructions_offset: 0,
    };
    await expect(prepareToolRequest(ctx as never, call)).resolves.toBeUndefined();
    expect(call.args).toEqual({});
    expect(call.heldForApproval).toBe(false);
    expect(call.effectRequest).toEqual({});
  });

  it("treats paging as a read even when model, instructions and forbidden fields are supplied", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.source.ownerStartedRun = false;
    const call = request();
    call.args = {
      instructions_offset: 8000,
      model: "other/model",
      instructions: "Changed",
      fleetManagement: true,
    };
    await expect(prepareToolRequest(ctx as never, call)).resolves.toBeUndefined();
    expect(call.args.instructions_offset).toBe(8000);
    expect(call.heldForApproval).toBe(false);
    expect(ctx.deps.prisma.bot.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("does not let zero offset bypass the checks for a real owner settings change", async () => {
    const { ctx, request } = ownBotUpdateCall();
    ctx.source.ownerStartedRun = false;
    const call = request();
    call.args = { instructions_offset: 0, model: "other/model" };
    await expect(prepareToolRequest(ctx as never, call)).resolves.toEqual({
      error:
        "Only the owner can change your model, thinking, voice or read-aloud, from their own chat.",
    });
  });

  it("removes zero offset and echoed profile fields before preparing instruction approval", async () => {
    const { ctx, live, request } = ownBotUpdateCall();
    const call = request();
    call.args = { instructions_offset: 0, name: live.name, instructions: "Use citations." };
    await expect(prepareToolRequest(ctx as never, call)).resolves.toBeUndefined();
    expect(call.heldForApproval).toBe(true);
    expect(call.args).toMatchObject({
      instructions: "Use citations.",
      previousInstructions: live.instructions,
      previousInstructionsFromBaseline: true,
    });
  });

  it("compares inherited models to the fresh default instead of an earlier attempt model", async () => {
    const { ctx, live, defaults, request } = ownBotUpdateCall();
    live.modelId = null;
    live.modelProvider = null;
    ctx.source.ownerStartedRun = false;
    const echoed = request();
    echoed.args = { model: "provider-a/fresh-default" };
    await expect(prepareToolRequest(ctx as never, echoed)).resolves.toBeUndefined();
    expect(echoed.args).toEqual({});
    defaults.defaultModelId = "new-default";
    const stale = request();
    stale.args = { model: "provider-a/fresh-default" };
    await expect(prepareToolRequest(ctx as never, stale)).resolves.toHaveProperty("error");
    const fresh = request();
    fresh.args = { model: "provider-a/new-default" };
    await expect(prepareToolRequest(ctx as never, fresh)).resolves.toBeUndefined();
    expect(fresh.args).toEqual({});
  });
});

describe("private task tools after shared-channel messages", () => {
  it.each([
    "schedule_create",
    "schedule_list",
    "schedule_update",
    "schedule_cancel",
    "skill_read",
    "skill_create",
    "skill_update",
    "skill_delete",
  ])("refuses %s for original and claimed shared-channel messages", async (name) => {
    for (const originalChannel of [true, false]) {
      const ctx = {
        deps: {
          prisma: { steeringMessage: { findFirst: vi.fn(async () => ({ id: "claimed" })) } },
        },
        run: {},
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: originalChannel },
      };
      const request = { name, args: {}, executionId: "call-1" } as ToolRequest;
      await expect(prepareToolRequest(ctx as never, request)).resolves.toEqual({
        error: "This tool is unavailable after a shared-channel message.",
      });
    }
  });

  it.each(["user", "bot_message", "webhook"])(
    "keeps %s task tools available without a channel message",
    async (trigger) => {
      const ctx = {
        deps: { prisma: { steeringMessage: { findFirst: async () => null } } },
        run: { trigger },
        bot: {},
        runId: "run-1",
        source: { messagingChannelRun: false },
      };
      for (const name of ["schedule_update", "skill_read"]) {
        await expect(
          prepareToolRequest(
            ctx as never,
            { name, args: {}, executionId: "call-1" } as ToolRequest,
          ),
        ).resolves.toBeUndefined();
      }
    },
  );
});

it.each(["message_bot", "handoff_to_bot"])(
  "rejects malformed %s files before approval persistence",
  async (name) => {
    const { ctx, request } = ownBotUpdateCall();
    const call = {
      ...request(),
      name,
      args: { files: "report.txt" },
      effectRequest: { files: "report.txt" },
    };
    expect(await prepareToolRequest(ctx as never, call)).toHaveProperty("error");
  },
);
