// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { useLingui } from "@lingui/react/macro";
import { useOutgoingDraft } from "@orkbot/chat-ui/outgoing-draft";
import { ChatMarkdown } from "@orkbot/chat-ui/web";
import { Button, Input, Textarea } from "@orkbot/ui-web";
import { useId, useRef } from "react";
import { translateApprovalReason } from "../lib/approval-messages";
import type { AskCardProps } from "./AskCard";
import { BuiCard } from "./ai/primitives";

export function OutgoingDraftCard({ block, canAnswer, onAnswer }: AskCardProps) {
  const { t } = useLingui();
  const draft = block.outgoingDraft!;
  const state = useOutgoingDraft(draft, onAnswer);
  const id = useId();
  const recipient = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const answered = block.status === "answered" || Boolean(state.accepted);
  // The persisted draft is authoritative when another client answered the ask.
  const fields = block.status === "answered" ? draft : state.fields;
  const disabled = answered || !canAnswer || state.pending || state.awaitingReview;
  const error =
    state.error === "recipient"
      ? t`Enter a recipient`
      : state.error === "body"
        ? t`Enter a message body`
        : state.error
          ? t`Could not submit this answer`
          : undefined;
  const denied = (block.status === "answered" ? block.answer : state.accepted) === "deny";
  return (
    <BuiCard data-testid="outgoing-draft-card" className="w-full min-w-0 max-w-xl px-5 py-4">
      <div className="text-[15.5px] leading-[1.5]">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {block.approvalReason ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {translateApprovalReason(block.approvalReason)}
        </p>
      ) : null}
      {block.detail ? (
        <pre
          data-testid="ask-detail"
          className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-sm text-muted-foreground"
        >
          {block.detail}
        </pre>
      ) : null}
      {draft.recipientChanged || state.awaitingReview ? (
        <p
          role="status"
          className="mt-3 text-sm text-muted-foreground"
        >{t`Recipient changed. Review the updated draft and press Send again.`}</p>
      ) : null}
      <form
        aria-label={t`Outgoing draft`}
        noValidate
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!fields.recipient.trim()) recipient.current?.focus();
          else if (!fields.body.trim()) body.current?.focus();
          void state.submit();
        }}
      >
        <div className="space-y-1">
          <label htmlFor={`${id}-recipient`} className="text-sm font-medium">{t`To`}</label>
          <Input
            id={`${id}-recipient`}
            name="recipient"
            ref={recipient}
            required
            value={fields.recipient}
            disabled={disabled}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={state.error === "recipient"}
            aria-describedby={state.error === "recipient" ? `${id}-error` : undefined}
            onChange={(event) => state.edit("recipient", event.target.value)}
          />
        </div>
        {draft.kind === "email" ? (
          <div className="space-y-1">
            <label htmlFor={`${id}-subject`} className="text-sm font-medium">{t`Subject`}</label>
            <Input
              id={`${id}-subject`}
              name="subject"
              value={fields.subject ?? ""}
              disabled={disabled}
              onChange={(event) => state.edit("subject", event.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1">
          <label htmlFor={`${id}-body`} className="text-sm font-medium">{t`Message body`}</label>
          <Textarea
            id={`${id}-body`}
            name="body"
            ref={body}
            required
            rows={7}
            value={fields.body}
            disabled={disabled}
            aria-invalid={state.error === "body"}
            aria-describedby={state.error === "body" ? `${id}-error` : undefined}
            onChange={(event) => state.edit("body", event.target.value)}
          />
        </div>
        {error ? (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {answered ? (
          <p className="text-sm text-muted-foreground">
            {denied ? t`Denied` : t`Approved to send`}
          </p>
        ) : !canAnswer ? (
          <p className="text-sm text-muted-foreground">{t`No longer active`}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-12" type="submit" disabled={disabled}>
              {state.pending ? t`Sending…` : t`Send`}
            </Button>
            <Button
              className="min-h-12"
              type="button"
              variant="outline"
              disabled={state.pending}
              onClick={() => void state.submit(true)}
            >{t`Reject`}</Button>
          </div>
        )}
      </form>
    </BuiCard>
  );
}
