// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AiRecipient } from "@orkbot/contracts";
import { aiConsentPrivacyUrl } from "@orkbot/core";
import { describe, expect, it, vi } from "vitest";
import {
  answerAiConsent,
  cancelAiConsentPrompts,
  currentAiConsentPrompt,
  promptAiConsent,
  subscribeAiConsent,
} from "./ai-consent";

const recipient: AiRecipient = {
  key: "fixture",
  name: "Fixture model",
  use: "model",
  detail: "",
  allowed: false,
};
describe("native renderer consent prompts", () => {
  it("fails closed when the disclosure host is unavailable", async () => {
    await expect(promptAiConsent(recipient)).resolves.toBe(false);
    expect(currentAiConsentPrompt()).toBeNull();
  });
  it("shows independent recipients in order and keeps decisions separate", async () => {
    const changed = vi.fn();
    const stop = subscribeAiConsent(changed);
    try {
      const first = promptAiConsent(recipient);
      const second = promptAiConsent({ ...recipient, key: "second", name: "Other" });
      const current = currentAiConsentPrompt()!;
      expect(current.recipient.key).toBe("fixture");
      answerAiConsent(current, true);
      await expect(first).resolves.toBe(true);
      expect(currentAiConsentPrompt()?.recipient.key).toBe("second");
      answerAiConsent(current, true);
      expect(currentAiConsentPrompt()?.recipient.key).toBe("second");
      answerAiConsent(currentAiConsentPrompt()!, false);
      await expect(second).resolves.toBe(false);
      expect(currentAiConsentPrompt()).toBeNull();
    } finally {
      stop();
    }
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:secret@example.test/policy",
    "invalid",
  ])("rejects unsafe server policy metadata (%s)", (url) => {
    expect(aiConsentPrivacyUrl(url)).toBe("https://ork.run/privacy/");
  });
  it("cancels the old scope and ignores an answer delivered after a replacement prompt", async () => {
    const stop = subscribeAiConsent(() => undefined);
    try {
      const old = promptAiConsent(recipient);
      const stale = currentAiConsentPrompt()!;
      cancelAiConsentPrompts();
      await expect(old).resolves.toBe(false);
      const next = promptAiConsent({ ...recipient, key: "new-scope" });
      answerAiConsent(stale, true);
      expect(currentAiConsentPrompt()?.recipient.key).toBe("new-scope");
      answerAiConsent(currentAiConsentPrompt()!, false);
      await expect(next).resolves.toBe(false);
    } finally {
      stop();
    }
  });
  it("declines outstanding requests when the host unmounts", async () => {
    const stop = subscribeAiConsent(() => undefined);
    const pending = promptAiConsent(recipient);
    stop();
    await expect(pending).resolves.toBe(false);
    expect(currentAiConsentPrompt()).toBeNull();
  });
});
