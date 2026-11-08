// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { MessageBlock } from "@orkbot/contracts";
import { expect, it } from "vitest";
import { userTurnMessageForRun } from "./attachments.js";

const messages = [
  {
    id: "direct",
    role: "user",
    blocks: [
      { kind: "bot_message_received", fromBotId: "sender", fromBotName: "Sender", text: "Review" },
    ] as MessageBlock[],
  },
  {
    id: "group",
    role: "bot",
    blocks: [
      { kind: "handoff", fromBotId: "sender", toBotId: "receiver", text: "Review" },
    ] as MessageBlock[],
  },
];

it("owns the exact incoming bot message as the current attachment source", () => {
  expect(userTurnMessageForRun("bot_message", "run", messages, "direct", "receiver")).toBe(
    messages[0],
  );
});
it("owns only the handoff addressed to this group member", () => {
  expect(userTurnMessageForRun("follow_up", "run", messages, "group", "receiver")).toBe(
    messages[1],
  );
  expect(userTurnMessageForRun("follow_up", "run", messages, "group", "other")).toBeUndefined();
});
it("does not adopt a delegation from unrelated history or a different trigger", () => {
  expect(userTurnMessageForRun("bot_message", "run", messages, null, "receiver")).toBeUndefined();
  expect(
    userTurnMessageForRun("bot_message", "run", messages, "group", "receiver"),
  ).toBeUndefined();
  expect(userTurnMessageForRun("follow_up", "run", messages, "direct", "receiver")).toBeUndefined();
  expect(userTurnMessageForRun("routine", "run", messages, "direct", "receiver")).toBeUndefined();
});
