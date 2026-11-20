// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

export const MeetingPlatformSchema = z.enum(["google_meet", "zoom", "microsoft_teams"]);
export type MeetingPlatform = z.infer<typeof MeetingPlatformSchema>;
export const UNSUPPORTED_MEETING_LINK =
  "Enter a Google Meet, Zoom, or Microsoft Teams meeting link.";

export function parseMeetingLink(value: string): { url: string; platform: MeetingPlatform } | null {
  if (value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  const { hostname, pathname } = url;
  url.hash = "";
  if (hostname === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(pathname))
    return { url: url.href, platform: "google_meet" };
  if (
    (hostname === "zoom.us" || hostname.endsWith(".zoom.us")) &&
    /^\/(?:j|wc\/join)\/\d{9,11}\/?$/.test(pathname)
  )
    return { url: url.href, platform: "zoom" };
  if (
    ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].includes(hostname) &&
    (/^\/meet\/\d{6,30}\/?$/.test(pathname) ||
      /^\/l\/meetup-join\/[a-z\d%:@._-]+\/\d+\/?$/i.test(pathname))
  )
    return { url: url.href, platform: "microsoft_teams" };
  return null;
}

export const MeetingStateSchema = z.enum([
  "scheduled",
  "joining",
  "recording",
  "processing",
  "completed",
  "failed",
  "canceled",
]);
export type MeetingState = z.infer<typeof MeetingStateSchema>;

export const MeetingTranscriptSegmentSchema = z
  .object({
    speaker: z.string().trim().min(1).max(200),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(4000),
  })
  .refine((segment) => segment.endMs >= segment.startMs, { path: ["endMs"] });
export type MeetingTranscriptSegment = z.infer<typeof MeetingTranscriptSegmentSchema>;
export const MeetingTranscriptSchema = z.array(MeetingTranscriptSegmentSchema).max(5000);

export const MeetingsStatusSchema = z.object({
  enabled: z.boolean(),
  dailyLimit: z.number().int().positive(),
  maxMinutes: z.number().int().positive(),
});

export const MeetingSummarySchema = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  platform: MeetingPlatformSchema,
  status: MeetingStateSchema,
  scheduledAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  error: z.string().nullable(),
});
export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
export const MeetingDetailSchema = MeetingSummarySchema.extend({
  transcript: MeetingTranscriptSchema,
});
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;

export const CreateMeetingInputSchema = z.object({
  botId: Id,
  url: z.string().trim().min(1).max(4096),
  title: z.string().trim().min(1).max(120).optional(),
  scheduledAt: IsoDate.optional(),
  confirmed: z.literal(true),
});
export type CreateMeetingInput = z.infer<typeof CreateMeetingInputSchema>;
