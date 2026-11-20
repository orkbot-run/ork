// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingProvider } from "@orkbot/adapter-kit";
import type { MeetingTranscriptSegment } from "@orkbot/contracts";
import { meetingWebhookEvent, verifyMeetingWebhook } from "./meeting-provider.js";
import { fetchSafeWebText, readBodyCapped, withAbort } from "./web-ssrf.js";

export const RECALL_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"] as const;
export interface RecallMeetingProviderOptions {
  apiKey: string;
  region: string;
  webhookSecret: string;
  legacyWebhookSecret?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

type Json = Record<string, any>;
const MAX_RESPONSE = 8 * 1024 * 1024;
const TIMEOUT = 20_000;

/** Recall calls are deliberately never retried: an ambiguous create must be reconciled by metadata. */
export class RecallMeetingProvider implements MeetingProvider {
  private readonly origin: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly options: RecallMeetingProviderOptions) {
    if (!(RECALL_REGIONS as readonly string[]).includes(options.region))
      throw new Error("Unsupported Recall region");
    if (!options.apiKey || !options.webhookSecret.startsWith("whsec_"))
      throw new Error("Recall credentials are required");
    this.origin = `https://${options.region}.recall.ai`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private async request(path: string, method = "GET", body?: Json): Promise<Json> {
    const signal = AbortSignal.timeout(TIMEOUT);
    const response = await withAbort(
      this.fetch(`${this.origin}/api/v1/${path}`, {
        method,
        signal,
        redirect: "error",
        headers: {
          Authorization: `Token ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      signal,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Recall request failed (${response.status})`);
    }
    const bytes = await readBodyCapped(response, MAX_RESPONSE, signal);
    return bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  }
  async lookup(meetingId: string): Promise<{ providerId: string } | null> {
    const body = await this.request(
      `bot/?metadata__ork_meeting_id=${encodeURIComponent(meetingId)}`,
    );
    if (!Array.isArray(body.results) || body.next)
      throw new Error("Recall lookup is incomplete; manual reconciliation required");
    if (body.results.length > 1)
      throw new Error("Multiple Recall bots found; manual reconciliation required");
    const bot = body.results[0];
    if (!bot) return null;
    if (bot.metadata?.ork_meeting_id !== meetingId)
      throw new Error("Recall lookup metadata mismatch");
    return { providerId: this.id(bot.id) };
  }
  async join(input: Parameters<MeetingProvider["join"]>[0]): Promise<{ providerId: string }> {
    if (
      !input.botName.trim() ||
      input.botName.length > 100 ||
      !Number.isInteger(input.maxSeconds) ||
      input.maxSeconds < 1 ||
      input.maxSeconds > 28_800
    )
      throw new Error("Invalid meeting bot settings");
    if (
      input.avatarBase64 &&
      (input.avatarBase64.length > 1_835_008 || !/^[A-Za-z0-9+/]+=*$/.test(input.avatarBase64))
    )
      throw new Error("Invalid meeting avatar");
    const existing = await this.lookup(input.meetingId);
    if (existing) return existing;
    const disclosure = `${input.botName} is recording audio and preparing a speaker-labelled transcript for the person who invited this bot.`;
    const body = await this.request("bot/", "POST", {
      meeting_url: input.url,
      bot_name: input.botName,
      metadata: { ork_meeting_id: input.meetingId },
      recording_config: {
        video_mixed_mp4: null,
        video_separate_mp4: null,
        audio_mixed_mp3: {},
        transcript: { provider: { recallai_async: { language_code: "auto" } } },
        retention: { type: "timed", hours: 24 },
      },
      automatic_leave: {
        in_call_recording_timeout: input.maxSeconds,
        in_call_not_recording_timeout: Math.min(input.maxSeconds, 300),
        waiting_room_timeout: 300,
        noone_joined_timeout: 300,
      },
      chat: {
        on_bot_join: { send_to: "everyone", message: disclosure },
        on_participant_join: { message: disclosure, exclude_host: false },
      },
      ...(input.avatarBase64
        ? {
            automatic_video_output: {
              in_call_recording: { kind: "jpeg", b64_data: input.avatarBase64 },
            },
          }
        : {}),
    });
    return { providerId: this.id(body.id) };
  }
  private id(value: unknown): string {
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
      throw new Error("Invalid Recall bot id");
    return value;
  }
  async get(providerId: string): Promise<Awaited<ReturnType<MeetingProvider["get"]>>> {
    const bot = await this.request(`bot/${this.id(providerId)}/`);
    const changes = Array.isArray(bot.status_changes) ? bot.status_changes : [];
    const status = changes.at(-1)?.code;
    if (status === "fatal" || status === "analysis_failed" || status === "media_expired")
      return { status: "failed", error: "Meeting provider could not produce the recording" };
    if (status === "done" || status === "analysis_done") return { status: "completed" };
    if (status === "in_call_recording") return { status: "recording" };
    if (["recording_done", "call_ended"].includes(status)) return { status: "processing" };
    return { status: "joining" };
  }
  async transcript(providerId: string): Promise<MeetingTranscriptSegment[] | null> {
    const bot = await this.request(`bot/${this.id(providerId)}/`);
    const recordings = bot.recordings;
    if (!Array.isArray(recordings) || recordings.length === 0) return null;
    if (recordings.length > 1) throw new Error("Multiple recording imports are unsupported");
    const media = recordings[0]?.media_shortcuts?.transcript;
    const status = media?.status?.code ?? media?.status;
    if (status !== "done") return null;
    const url = new URL(media.data?.download_url);
    if (url.protocol !== "https:") throw new Error("Recall transcript download must use HTTPS");
    // Checked DNS/addresses and pinned connections, bounded body/deadline, no credentials, no redirects.
    const result = await fetchSafeWebText(url.href, {
      fetch: this.options.fetch,
      maxBytes: MAX_RESPONSE,
      timeoutMs: TIMEOUT,
      allowedPorts: [443],
      maxRedirects: 0,
    });
    return normalizeRecallTranscript(JSON.parse(result.body));
  }
  async leave(providerId: string): Promise<void> {
    await this.request(`bot/${this.id(providerId)}/leave_call/`, "POST");
  }
  async removeMedia(providerId: string): Promise<void> {
    await this.request(`bot/${this.id(providerId)}/delete_media/`, "POST");
  }
  parseWebhook(raw: Uint8Array, headers: Headers): { providerId: string } | "ignored" | null {
    const secret = headers.has("webhook-id")
      ? this.options.webhookSecret
      : this.options.legacyWebhookSecret;
    return verifyMeetingWebhook(raw, headers, secret, this.options.now?.())
      ? meetingWebhookEvent(raw)
      : null;
  }
}

export function normalizeRecallTranscript(value: unknown): MeetingTranscriptSegment[] {
  if (!Array.isArray(value) || value.length > 5000)
    throw new Error("Invalid or oversized Recall transcript");
  let characters = 0;
  return value.map((segment: Json) => {
    if (
      !segment ||
      !Array.isArray(segment.words) ||
      !segment.words.length ||
      segment.words.length > 20_000
    )
      throw new Error("Invalid Recall transcript segment");
    const text = segment.words
      .map((word: Json) => {
        if (typeof word.text !== "string") throw new Error("Invalid transcript text");
        return word.text;
      })
      .join(" ");
    characters += text.length;
    const startMs = Math.round(segment.words[0].start_timestamp?.relative * 1000);
    const endMs = Math.round(segment.words.at(-1).end_timestamp?.relative * 1000);
    if (
      characters > 2_000_000 ||
      !text.trim() ||
      text.length > 4000 ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs < startMs ||
      endMs > 86_400_000
    )
      throw new Error("Invalid or oversized transcript content");
    const name = segment.participant?.name;
    const speaker =
      typeof name === "string" && name.trim()
        ? name.slice(0, 200)
        : `Speaker ${String(segment.participant?.id ?? "unknown").slice(0, 40)}`;
    return { speaker, startMs, endMs, text };
  });
}
