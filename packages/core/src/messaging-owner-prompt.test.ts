// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { AppLocaleSchema } from "@orkbot/contracts";
import { describe, expect, it } from "vitest";
import { formatMessagingOwnerPrompt } from "./messaging-owner-prompt.js";
import { TAKEOVER_COMPUTER_PENDING_STATE } from "./thread-message-updates.js";

const ask = { kind: "ask", text: "Which destination?", status: "pending" };
const computer = {
  kind: "computer",
  state: TAKEOVER_COMPUTER_PENDING_STATE,
  text: "Please sign in to continue.",
};

describe("formatMessagingOwnerPrompt", () => {
  it("preserves question, details and option order while omitting action IDs and other values", () => {
    expect(
      formatMessagingOwnerPrompt(
        {
          ...ask,
          detail: "Two routes are available.\nPick one.",
          actions: [
            { id: "private-b", label: "Lisbon" },
            { id: "private-a", label: "Warsaw" },
          ],
          value: "private-value",
        },
        "waiting_input",
        "pl-PL",
      ),
    ).toBe(
      "Which destination?\n\nTwo routes are available.\nPick one.\n\n1. Lisbon\n2. Warsaw\n\n(Odpowiedz w aplikacji.)",
    );
  });

  it("accepts unanswered legacy cards and an empty stored answer", () => {
    expect(formatMessagingOwnerPrompt({ kind: "ask", text: "Continue?" }, "waiting_input")).toBe(
      "Continue?\n\n(Reply in the app.)",
    );
    expect(formatMessagingOwnerPrompt({ ...ask, answer: "" }, "waiting_input")).toBeDefined();
  });

  it.each([
    null,
    [],
    "question",
    { ...ask, text: 5 },
    { ...ask, text: "   " },
    { ...ask, detail: {} },
    { ...ask, actions: "yes" },
    { ...ask, actions: [null] },
    { ...ask, actions: [{ id: "a", label: 3 }] },
    { ...ask, actions: [{ id: "a", label: " " }] },
    { ...ask, actions: [{ label: "Yes" }] },
    { ...ask, status: "answered" },
    { ...ask, status: "dismissed" },
    { ...ask, dismissed: true },
    { ...ask, answer: "private-answer" },
    { ...ask, status: undefined, answer: "legacy-answer" },
    { ...ask, answer: {} },
    { ...ask, input: "password" },
    { ...ask, approvalEffectId: 5 },
    { ...ask, approvalEffectId: "effect", actions: [{ id: "unexpected", label: "Approve" }] },
    { kind: "text", text: "Not a question" },
    { kind: "choice", title: "Not an ask", options: [] },
  ])("ignores invalid or resolved input: %j", (block) => {
    expect(formatMessagingOwnerPrompt(block, "waiting_input")).toBeUndefined();
  });

  it.each([
    { input: "secret" },
    {
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "private-allow-label" },
        { id: "deny", label: "private-deny-label" },
      ],
    },
  ])("redacts protected titles and excludes details, actions and values: %j", (protection) => {
    const result = formatMessagingOwnerPrompt(
      {
        ...ask,
        text: "Use token=private-credential-value?",
        detail: "private-detail",
        credential: undefined,
        value: "private-value",
        ...protection,
      },
      "waiting_input",
      "pl",
    );
    expect(result).toBe("Use token=[Redacted]\n\n(Odpowiedz w aplikacji.)");
  });

  it("formats only the real pending takeover card", () => {
    expect(formatMessagingOwnerPrompt(computer, "waiting_takeover", "pl")).toBe(
      "Please sign in to continue.\n\n(Przejmij ekran w aplikacji.)",
    );
    for (const block of [ask, { ...computer, state: "Done" }, { kind: "takeover", text: "Why" }]) {
      expect(formatMessagingOwnerPrompt(block, "waiting_takeover")).toBeUndefined();
    }
    expect(formatMessagingOwnerPrompt(computer, "waiting_input")).toBeUndefined();
    expect(formatMessagingOwnerPrompt(ask, "working")).toBeUndefined();
    expect(formatMessagingOwnerPrompt(computer, "waiting_input")).toBeUndefined();
    expect(formatMessagingOwnerPrompt(ask, "completed")).toBeUndefined();
  });

  it.each(AppLocaleSchema.options)("provides translated hints for %s", (locale) => {
    const question = formatMessagingOwnerPrompt(ask, "waiting_input", locale);
    const takeover = formatMessagingOwnerPrompt(computer, "waiting_takeover", locale);
    expect(question?.startsWith(ask.text)).toBe(true);
    expect(takeover?.startsWith(computer.text)).toBe(true);
    if (locale !== "en") {
      expect(question).not.toContain("Reply in the app");
      expect(takeover).not.toContain("Take over the screen in the app");
    }
  });

  it("normalizes locale tags with the shared matcher and falls back to English", () => {
    expect(formatMessagingOwnerPrompt(ask, "waiting_input", " PL_pl ")).toContain("Odpowiedz");
    expect(formatMessagingOwnerPrompt(ask, "waiting_input", "pt-PT")).toContain("Responda");
    expect(formatMessagingOwnerPrompt(ask, "waiting_input", "zh-Hant-HK")).toContain("應用程式");
    expect(formatMessagingOwnerPrompt(ask, "waiting_input", "iw-IL")).toContain("באפליקציה");
    for (const locale of [undefined, null, "", "unknown"]) {
      expect(formatMessagingOwnerPrompt(ask, "waiting_input", locale)).toContain(
        "Reply in the app",
      );
    }
  });
});
