// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AiRecipient } from "@orkbot/contracts";
import { AI_PRIVACY_URL } from "@orkbot/contracts";
import { aiConsentPrivacyUrl } from "@orkbot/core";

type ConsentPrompt = {
  recipient: AiRecipient;
  privacyUrl: string;
  resolve(allowed: boolean): void;
};
const pending: ConsentPrompt[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function subscribeAiConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      cancelAiConsentPrompts();
    }
  };
}

export function cancelAiConsentPrompts() {
  for (const prompt of pending.splice(0)) prompt.resolve(false);
  emit();
}

export const currentAiConsentPrompt = () => pending[0] ?? null;

/** Without a mounted native renderer, fail closed rather than accepting unseen consent. */
export function promptAiConsent(recipient: AiRecipient, privacyUrl = AI_PRIVACY_URL) {
  if (listeners.size === 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending.push({ recipient, privacyUrl: aiConsentPrivacyUrl(privacyUrl), resolve });
    emit();
  });
}

export function answerAiConsent(prompt: ConsentPrompt, allowed: boolean) {
  if (pending[0] !== prompt) return;
  pending.shift();
  prompt.resolve(allowed);
  emit();
}
