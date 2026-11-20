// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { outgoingDraftForEffect, patchOutgoingDraftEffect } from "./outgoing-draft.js";

const email = {
  to: "client@example.test",
  subject: "Hello",
  body: "Original text",
  is_html: false,
};
const edited = { recipient: "client@example.test", subject: "Updated", body: "User's revision" };
const route = {
  connectorId: "pipedream",
  resourceId: "gmail",
  toolName: "send_email",
  connectionId: "account-a",
};

describe("outgoing drafts bound to known send requests", () => {
  it("shows full email text and updates existing fields without mutating the proposal", () => {
    expect(outgoingDraftForEffect("GMAIL_SEND_EMAIL", email)).toEqual({
      kind: "email",
      recipient: email.to,
      subject: email.subject,
      body: email.body,
    });
    expect(patchOutgoingDraftEffect("GMAIL_SEND_EMAIL", email, edited)).toEqual({
      ...email,
      subject: edited.subject,
      body: edited.body,
    });
    expect(email.body).toBe("Original text");
  });
  it("preserves one-recipient arrays and permits an explicitly supplied email subject", () => {
    const args = { to: [email.to], body: email.body };
    expect(
      patchOutgoingDraftEffect("gmail_send_email", args, {
        recipient: "new@example.test",
        body: "New",
      }),
    ).toEqual({ to: ["new@example.test"], body: "New" });
    expect(patchOutgoingDraftEffect("gmail_send_email", args, edited)).toEqual({
      ...args,
      subject: edited.subject,
      body: edited.body,
    });
  });
  it("supports Markdown and falls back for text outside the editable draft limits", () => {
    const body = "Intro\n\n***\n\nMore";
    expect(outgoingDraftForEffect("GMAIL_SEND_EMAIL", { ...email, body })?.body).toBe(body);
    expect(
      outgoingDraftForEffect("GMAIL_SEND_EMAIL", { ...email, body: "x".repeat(100_001) }),
    ).toBeUndefined();
  });
  it.each([
    ["[SECRET: token]", true],
    ["unrelated ] then [HiDdEn value]", true],
    ["[secret [hidden]", true],
    ["[secret\nvalue]", true],
    ["[secrets]", true],
    ["[secret", false],
    ["] [hidden", false],
    ["[unmasked]", false],
    [`[secret${"[hidden".repeat(10_000)}`, false],
    [`[secret${"[hidden".repeat(10_000)}]`, true],
  ] as const)("preserves masked marker detection (case %#)", (body, isMasked) => {
    const request = { ...email, body };
    const draft = outgoingDraftForEffect("gmail_send_email", request);
    const patched = patchOutgoingDraftEffect("gmail_send_email", email, { ...edited, body });
    if (isMasked) {
      expect(draft).toBeUndefined();
      expect(patched).toBeUndefined();
    } else {
      expect(draft?.body).toBe(body);
      expect(patched).toMatchObject({ body });
    }
  });
  it("patches trusted direct and catalog envelopes without changing routing or account", () => {
    const direct = ["__orkbotCatalogTool", "direct", { route, args: email }];
    const catalog = [
      "__orkbotCatalogTool",
      "pipedream_execute_tool",
      { id: "gmail:account-a:send_email", arguments: email },
      route,
    ];
    for (const request of [direct, catalog]) {
      expect(outgoingDraftForEffect("send_email__account", request)?.body).toBe(email.body);
      const patched = patchOutgoingDraftEffect("send_email__account", request, edited);
      expect(outgoingDraftForEffect("send_email__account", patched)?.body).toBe(edited.body);
      expect(JSON.stringify(patched)).toContain('"connectionId":"account-a"');
    }
    expect(outgoingDraftForEffect("send_email", catalog.slice(0, 3))).toBeUndefined();
  });
  it("allows exactly one known send in a batch", () => {
    const item = { tool_slug: "GMAIL_SEND_EMAIL", arguments: email };
    const request = { tools: [item], sync_response_to_workbench: true };
    const kind = "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL";
    expect(outgoingDraftForEffect(kind, request)?.body).toBe(email.body);
    expect(
      outgoingDraftForEffect(kind, patchOutgoingDraftEffect(kind, request, edited))?.body,
    ).toBe(edited.body);
    expect(outgoingDraftForEffect(kind, { tools: [item, item] })).toBeUndefined();
  });
  it.each([
    { ...email, recipient_email: "other@example.test" },
    { ...email, recipient_email: "" },
    { ...email, text: "" },
    { ...email, cc: ["other@example.test"] },
    { ...email, bcc: ["hidden@example.test"] },
    { ...email, body: "[redacted]" },
    { ...email, to: [email.to, "other@example.test"] },
    { ...email, html_body: "Parallel body" },
    { ...email, custom_destination: "hidden@example.test" },
    { ...email, attachments: [{ id: "file" }] },
  ])("refuses ambiguous, hidden, or masked payloads: %j", (args) => {
    expect(outgoingDraftForEffect("gmail_send_email", args)).toBeUndefined();
    expect(patchOutgoingDraftEffect("gmail_send_email", args, edited)).toBeUndefined();
  });
  it("supports Slack and Telegram sends while excluding blocks and implicit-recipient replies", () => {
    expect(
      outgoingDraftForEffect("SLACK_SEND_MESSAGE", {
        channel: "C123",
        text: "Full message",
        thread_ts: "123.4",
      }),
    ).toEqual({ kind: "message", recipient: "C123", body: "Full message" });
    expect(
      outgoingDraftForEffect("TELEGRAM_SEND_MESSAGE", { chat_id: "123", text: "Hi" })?.kind,
    ).toBe("message");
    expect(
      outgoingDraftForEffect("SLACK_SEND_MESSAGE", { channel: "C123", text: "Hi", blocks: [{}] }),
    ).toBeUndefined();
    expect(
      outgoingDraftForEffect("GMAIL_REPLY_TO_THREAD", { thread_id: "t", body: "Hi" }),
    ).toBeUndefined();
    expect(outgoingDraftForEffect("custom_send_email", email)).toBeUndefined();
  });
  it.each(["", "   ", "[redacted]"])("rejects empty or masked edits: %j", (body) => {
    expect(
      patchOutgoingDraftEffect("gmail_send_email", email, { ...edited, body }),
    ).toBeUndefined();
  });
});
