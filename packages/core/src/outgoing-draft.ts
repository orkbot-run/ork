// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { OutgoingDraft } from "@orkbot/contracts";
import { OutgoingDraftAnswerSchema } from "@orkbot/contracts";

export type OutgoingDraftJsonValue =
  | string
  | number
  | boolean
  | null
  | OutgoingDraftJsonObject
  | OutgoingDraftJsonValue[];
export type OutgoingDraftJsonObject = { [key: string]: OutgoingDraftJsonValue };
export type OutgoingDraftEdit = { recipient: string; subject?: string; body: string };
export type OutgoingDraftBinding = {
  kind: "email" | "message";
  recipientKeys: readonly string[];
  bodyKeys: readonly string[];
  subjectKey?: string;
};

const EMAIL: OutgoingDraftBinding = {
  kind: "email",
  recipientKeys: ["to", "to_email", "recipient_email", "recipient", "recipients", "to_recipients"],
  bodyKeys: ["body", "message", "text", "content"],
  subjectKey: "subject",
};
const SLACK: OutgoingDraftBinding = {
  kind: "message",
  recipientKeys: ["channel", "channel_id"],
  bodyKeys: ["text", "message"],
};
/** Explicit send operations only: drafts, replies with implicit recipients, and raw MIME are excluded. */
export function outgoingDraftBindingForTool(name: string): OutgoingDraftBinding | undefined {
  const normalized = name.toLowerCase();
  const parts = normalized.split("__");
  const operation =
    parts.findLast((part) =>
      /^(gmail|outlook|microsoft_outlook|msoutlook|microsoft365|slack|telegram|discord|teams)_/.test(
        part,
      ),
    ) ?? normalized;
  if (
    /^(gmail|outlook|microsoft_outlook|msoutlook|microsoft365)_(send_email|send_mail|send_message)$/.test(
      operation,
    )
  )
    return EMAIL;
  if (/^slack_(send_message|post_message|chat_post_message)$/.test(operation)) return SLACK;
  if (/^telegram_send_message$/.test(operation))
    return { kind: "message", recipientKeys: ["chat_id"], bodyKeys: ["text"] };
  if (/^(discord|teams)_send_message$/.test(operation))
    return {
      kind: "message",
      recipientKeys: ["channel_id", "channel"],
      bodyKeys: ["content", "text", "message"],
    };
  return undefined;
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
// Masked values cannot safely be round-tripped into the actual tool arguments.
function masked(value: string): boolean {
  // Any marker before the last closing bracket has a closing bracket after it.
  // Check fixed prefixes once, without rescanning an unterminated suffix per marker.
  const end = value.lastIndexOf("]");
  if (end < 0) return false;
  const prefix = value.slice(0, end).toLowerCase();
  return prefix.includes("[redacted") || prefix.includes("[secret") || prefix.includes("[hidden");
}
const populated = (v: unknown) =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);

type Located = { name: string; args: Record<string, unknown> };
function locate(kind: string, request: unknown): Located | undefined {
  if (Array.isArray(request)) {
    if (request[0] !== "__orkbotCatalogTool") return;
    if (request.length === 3 && request[1] === "direct" && record(request[2])) {
      const { route, args } = request[2];
      if (!validRoute(route) || !record(args)) return;
      return locate(routeName(route), args);
    }
    // Older catalog envelopes do not bind a provider: keep them as ordinary approvals.
    if (
      request.length !== 4 ||
      typeof request[1] !== "string" ||
      !request[1].endsWith("_execute_tool") ||
      !record(request[2]) ||
      !validRoute(request[3])
    )
      return;
    const wrapper = request[2];
    if (!record(wrapper.arguments)) return;
    return locate(routeName(request[3]), wrapper.arguments);
  }
  if (!record(request)) return;
  if (/(?:^|__)composio_multi_execute_tool$/i.test(kind)) {
    if (!Array.isArray(request.tools) || request.tools.length !== 1 || !record(request.tools[0]))
      return;
    const item = request.tools[0];
    if (typeof item.tool_slug !== "string" || !record(item.arguments)) return;
    return { name: item.tool_slug, args: item.arguments };
  }
  return { name: kind, args: request };
}
function validRoute(route: unknown): route is Record<string, unknown> & {
  toolName: string;
  resourceId: string;
  connectorId: string;
} {
  return (
    record(route) &&
    typeof route.connectorId === "string" &&
    typeof route.resourceId === "string" &&
    typeof route.toolName === "string"
  );
}
function routeName(route: { toolName: string; resourceId: string }): string {
  const provider = route.resourceId.toLowerCase();
  // Pipedream catalogs name the operation without its app prefix.
  return /^(gmail|outlook|microsoft_outlook|msoutlook|slack|telegram|discord|teams)$/.test(
    provider,
  ) && !route.toolName.toLowerCase().startsWith(`${provider}_`)
    ? `${provider}_${route.toolName}`
    : route.toolName;
}
function bound(kind: string, request: unknown) {
  const located = locate(kind, request);
  if (!located) return;
  const binding = outgoingDraftBindingForTool(located.name);
  if (!binding) return;
  const { args } = located;
  const recipients = binding.recipientKeys.filter((key) => populated(args[key]));
  const bodies = binding.bodyKeys.filter((key) => populated(args[key]));
  if (recipients.length !== 1 || bodies.length !== 1) return;
  const recipientKey = recipients[0]!;
  const bodyKey = bodies[0]!;
  // Even an empty alternate alias may take precedence in the provider's implementation.
  if (
    [...binding.recipientKeys, ...binding.bodyKeys].some(
      (key) =>
        key !== recipientKey &&
        key !== bodyKey &&
        Object.hasOwn(args, key) &&
        args[key] !== undefined,
    )
  )
    return;
  const recipientValue = args[recipientKey];
  const recipient =
    typeof recipientValue === "string"
      ? recipientValue
      : Array.isArray(recipientValue) &&
          recipientValue.length === 1 &&
          typeof recipientValue[0] === "string"
        ? recipientValue[0]
        : undefined;
  const body = args[bodyKey];
  if (!recipient?.trim() || typeof body !== "string" || !body.trim()) return;
  // A second destination or a parallel payload would make the editable card incomplete.
  const unsafe = [
    "cc",
    "bcc",
    "cc_recipients",
    "bcc_recipients",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "blocks",
    "attachments",
    "html",
    "html_body",
    "raw",
    "mime",
    "payload",
  ];
  if (unsafe.some((key) => populated(args[key]))) return;
  const metadata =
    binding.kind === "email"
      ? ["is_html", "body_type", "thread_id", "user_id", "importance", "save_to_sent_items"]
      : [
          "thread_ts",
          "reply_broadcast",
          "unfurl_links",
          "unfurl_media",
          "parse",
          "link_names",
          "mrkdwn",
          "username",
          "icon_url",
          "icon_emoji",
          "disable_notification",
          "protect_content",
          "parse_mode",
          "reply_to_message_id",
        ];
  const allowed = new Set([
    ...binding.recipientKeys,
    ...binding.bodyKeys,
    ...metadata,
    ...(binding.subjectKey ? [binding.subjectKey] : []),
  ]);
  if (Object.entries(args).some(([key, value]) => !allowed.has(key) && populated(value))) return;
  const subject = binding.subjectKey ? args[binding.subjectKey] : undefined;
  if (subject !== undefined && typeof subject !== "string") return;
  if ([recipient, body, subject].some((v) => typeof v === "string" && masked(v))) return;
  return {
    args,
    binding,
    recipientKey,
    bodyKey,
    recipient,
    body,
    subject,
    arrayRecipient: Array.isArray(recipientValue),
  };
}

export function outgoingDraftForEffect(kind: string, request: unknown): OutgoingDraft | undefined {
  const result = bound(kind, request);
  if (!result) return;
  const fields = {
    recipient: result.recipient,
    body: result.body,
    ...(typeof result.subject === "string" ? { subject: result.subject } : {}),
  };
  if (!OutgoingDraftAnswerSchema.shape.outgoingDraft.safeParse(fields).success) return;
  return { kind: result.binding.kind, ...fields };
}

/** Clone and patch only fields the known send schema binds. Never adds hidden recipients. */
export function patchOutgoingDraftEffect(
  kind: string,
  request: unknown,
  edit: OutgoingDraftEdit,
): OutgoingDraftJsonObject | OutgoingDraftJsonValue[] | undefined {
  if (
    typeof edit.recipient !== "string" ||
    !edit.recipient.trim() ||
    typeof edit.body !== "string" ||
    !edit.body.trim() ||
    (edit.subject !== undefined && typeof edit.subject !== "string") ||
    [edit.recipient, edit.body, edit.subject].some((v) => typeof v === "string" && masked(v))
  )
    return;
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(request));
  } catch {
    return;
  }
  const target = bound(kind, copy);
  if (!target) return;
  target.args[target.recipientKey] = target.arrayRecipient ? [edit.recipient] : edit.recipient;
  target.args[target.bodyKey] = edit.body;
  if (target.binding.subjectKey && edit.subject !== undefined)
    target.args[target.binding.subjectKey] = edit.subject;
  else if (!target.binding.subjectKey && edit.subject !== undefined && edit.subject !== "") return;
  return copy as OutgoingDraftJsonObject | OutgoingDraftJsonValue[];
}
