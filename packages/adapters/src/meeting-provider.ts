// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createHmac, timingSafeEqual } from "node:crypto";

/** Verify the original bytes before parsing. Both Recall workspace and legacy Svix use this format. */
export function verifyMeetingWebhook(
  raw: Uint8Array,
  headers: Headers,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret?.startsWith("whsec_") || raw.byteLength > 256 * 1024) return false;
  const prefix = headers.has("webhook-id") ? "webhook" : "svix";
  const id = headers.get(`${prefix}-id`);
  const timestamp = headers.get(`${prefix}-timestamp`);
  const signatures = headers.get(`${prefix}-signature`);
  if (
    !id ||
    id.length > 256 ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    !signatures ||
    signatures.length > 4096
  )
    return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest();
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    if (version !== "v1" || !signature) return false;
    const actual = Buffer.from(signature, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export function meetingWebhookEvent(raw: Uint8Array): { providerId: string } | "ignored" | null {
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (typeof body.event !== "string") return "ignored";
    if (!/^(bot|recording|transcript)\./.test(body.event)) return "ignored";
    const id = body.data?.bot?.id ?? body.data?.bot_id;
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
      ? { providerId: id }
      : "ignored";
  } catch {
    return null;
  }
}
