// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { OutgoingDraft } from "@orkbot/contracts";
import { useRef, useState } from "react";

export type DraftFields = Pick<OutgoingDraft, "recipient" | "subject" | "body">;
export type DraftError = "recipient" | "body" | "submit";

export function outgoingDraftAnswer(draft: DraftFields, reviewId?: string): string {
  return JSON.stringify({ outgoingDraft: draft, ...(reviewId ? { reviewId } : {}) });
}

/** Both renderers share validation, submission locking and recipient-review behavior. */
export function useOutgoingDraft(
  draft: OutgoingDraft,
  onAnswer: (answer: string) => Promise<void>,
) {
  const [fields, setFields] = useState<DraftFields>(() => ({
    recipient: draft.recipient,
    ...(draft.subject !== undefined ? { subject: draft.subject } : {}),
    body: draft.body,
  }));
  const [pending, setPending] = useState(false);
  const [awaitingReview, setAwaitingReview] = useState(false);
  const [accepted, setAccepted] = useState<"allow" | "deny">();
  const [error, setError] = useState<DraftError>();
  const locked = useRef(false);
  function edit(field: keyof DraftFields, value: string) {
    setFields((current) => ({ ...current, [field]: value }));
    setError(undefined);
  }
  async function submit(deny = false) {
    if (locked.current || accepted || (awaitingReview && !deny)) return;
    if (!deny && !fields.recipient.trim()) {
      setError("recipient");
      return;
    }
    if (!deny && !fields.body.trim()) {
      setError("body");
      return;
    }
    locked.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onAnswer(deny ? "deny" : outgoingDraftAnswer(fields, draft.reviewId));
      if (!deny && fields.recipient !== draft.recipient) setAwaitingReview(true);
      else setAccepted(deny ? "deny" : "allow");
    } catch {
      setError("submit");
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  return { fields, edit, pending, awaitingReview, accepted, error, submit };
}
