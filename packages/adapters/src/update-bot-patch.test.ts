// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import type { OwnBotSettingsRow } from "./own-bot-settings.js";
import { dropUnchangedOwnBotArgs, ownBotInstructionsOffset } from "./update-bot-patch.js";

const bot: OwnBotSettingsRow = {
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
const effective = { provider: "provider-a", model: "model-1", label: "Provider A: Model One" };

describe("dropUnchangedOwnBotArgs", () => {
  it("drops echoed settings, whitespace, omitted fields and false image flags", () => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          name: " Scout ",
          description: bot.description,
          instructions: " Cite sources.\n",
          color: bot.color,
          thinkingLevel: "default",
          voice: "default",
          readAloud: false,
          notifyOnFinish: false,
          dailyCheckIns: false,
          use_attached_image: false,
          instructions_offset: 0,
          instructionsOffset: "0",
          model: null,
          unused: " ",
          other: undefined,
        },
        bot,
      ),
    ).toEqual({});
  });

  it.each(["model-1", "provider-a/model-1", "Provider A: Model One"])(
    "accepts the exact current model representation %s",
    (model) => {
      expect(dropUnchangedOwnBotArgs({ model }, bot, effective)).toEqual({});
    },
  );

  it.each(["provider-b/model-1", "provider-a/model-10", "Model One", "model-1 (provider-b)"])(
    "preserves a different or unqualified model representation %s",
    (model) => {
      expect(dropUnchangedOwnBotArgs({ model }, bot, effective)).toEqual({ model });
    },
  );

  it("only drops the actual read label of an inherited default", () => {
    const model = { ...effective, label: `${effective.label} (default)` };
    expect(dropUnchangedOwnBotArgs({ model: model.label }, bot, model)).toEqual({});
    expect(dropUnchangedOwnBotArgs({ model: effective.label }, bot, model)).toEqual({
      model: effective.label,
    });
  });

  it.each(["false", " FALSE "])("normalizes false flags and their alias: %s", (value) => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          notify_on_finish: value,
          dailyCheckIns: value,
          readAloud: value,
          use_attached_image: value,
        },
        bot,
      ),
    ).toEqual({});
  });

  it("keeps the canonical notification flag authoritative over a conflicting alias", () => {
    expect(dropUnchangedOwnBotArgs({ notifyOnFinish: false, notify_on_finish: true }, bot)).toEqual(
      {},
    );
    expect(dropUnchangedOwnBotArgs({ notifyOnFinish: true, notify_on_finish: false }, bot)).toEqual(
      { notifyOnFinish: true },
    );
    expect(dropUnchangedOwnBotArgs({ notify_on_finish: "true" }, bot)).toEqual({
      notifyOnFinish: true,
    });
  });

  it("normalizes changed true flags and keeps invalid boolean values for validation", () => {
    expect(
      dropUnchangedOwnBotArgs(
        {
          notifyOnFinish: " true ",
          dailyCheckIns: "true",
          readAloud: "TRUE",
          use_attached_image: "true",
        },
        bot,
      ),
    ).toEqual({
      notifyOnFinish: true,
      dailyCheckIns: true,
      readAloud: true,
      use_attached_image: true,
    });
    const args = { notifyOnFinish: "yes", dailyCheckIns: 0, readAloud: {}, use_attached_image: [] };
    expect(dropUnchangedOwnBotArgs(args, bot)).toEqual(args);
  });

  it("preserves real settings changes and artifact requests", () => {
    const args = {
      name: "Other",
      instructions: "Use citations.",
      color: "red",
      thinkingLevel: "high",
      voice: "voice-2",
      artifact_id: bot.color,
    };
    expect(dropUnchangedOwnBotArgs(args, bot)).toEqual(args);
    expect(
      dropUnchangedOwnBotArgs(
        { artifact_id: "image-1" },
        { ...bot, color: "data:image/png;base64,fake" },
      ),
    ).toEqual({ artifact_id: "image-1" });
  });

  it("preserves unknown own keys without reading inherited properties or mutating arguments", () => {
    const args = JSON.parse(
      '{"__proto__":"keep","constructor":"keep","toString":"keep","fleetManagement":true,"name":"Scout"}',
    );
    const before = structuredClone(args);
    const result = dropUnchangedOwnBotArgs(args, bot);
    expect(Object.keys(result)).toEqual([
      "__proto__",
      "constructor",
      "toString",
      "fleetManagement",
    ]);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(args).toEqual(before);
    expect(
      dropUnchangedOwnBotArgs(Object.create({ name: "Other", fleetManagement: true }), bot),
    ).toEqual({});
  });
});

describe("ownBotInstructionsOffset", () => {
  it.each([
    {},
    { instructions_offset: null },
    { instructions_offset: " " },
    { instructions_offset: 0 },
    { instructions_offset: "0" },
  ])("defaults %j to zero", (args) => {
    expect(ownBotInstructionsOffset(args)).toBe(0);
  });
  it.each([{ instructions_offset: 8_000 }, { instructionsOffset: "8000" }])(
    "accepts %j",
    (args) => {
      expect(ownBotInstructionsOffset(args)).toBe(8_000);
    },
  );
  it.each([-1, 0.5, "not-a-number", true, false, {}, [], Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid offset %j",
    (instructions_offset) => {
      expect(ownBotInstructionsOffset({ instructions_offset })).toEqual({
        error: "instructions_offset must be a whole number of 0 or more.",
      });
    },
  );
});
