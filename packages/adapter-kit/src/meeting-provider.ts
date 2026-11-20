// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingPlatform, MeetingTranscriptSegment } from "@orkbot/contracts";

export interface MeetingProvider {
  /** Create a participant for the authorized meeting. Creation can have an ambiguous outcome. */
  join(input: {
    meetingId: string;
    url: string;
    platform: MeetingPlatform;
    botName: string;
    maxSeconds: number;
    avatarBase64?: string;
  }): Promise<{ providerId: string }>;
  /** Recover a participant after an interrupted create by its stable local ID. */
  lookup?(meetingId: string): Promise<{ providerId: string } | null>;
  get(providerId: string): Promise<{
    status: "joining" | "recording" | "processing" | "completed" | "failed";
    error?: string;
  }>;
  transcript(providerId: string): Promise<MeetingTranscriptSegment[] | null>;
  leave(providerId: string): Promise<void>;
  removeMedia(providerId: string): Promise<void>;
  parseWebhook(raw: Uint8Array, headers: Headers): { providerId: string } | "ignored" | null;
}
