// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createHmac } from "node:crypto";
import type { MeetingProvider } from "@orkbot/adapter-kit";
import type { MeetingTranscriptSegment } from "@orkbot/contracts";
import { meetingWebhookEvent, verifyMeetingWebhook } from "./meeting-provider.js";

type State = Awaited<ReturnType<MeetingProvider["get"]>>;
const STATES = ["joining", "recording", "processing", "completed"] as const;
export interface MeetingEmulatorOptions {
  webhookSecret?: string;
  now?: () => number;
  autoAdvance?: boolean;
}
export class MeetingEmulator implements MeetingProvider {
  private readonly bots = new Map<
    string,
    {
      meetingId: string;
      state: State;
      mediaRemoved: boolean;
      transcript: MeetingTranscriptSegment[];
    }
  >();
  readonly webhookSecret: string;
  constructor(private readonly options: MeetingEmulatorOptions = {}) {
    this.webhookSecret =
      options.webhookSecret ??
      `whsec_${Buffer.from("ork-meeting-emulator-local-secret").toString("base64")}`;
  }
  async lookup(meetingId: string): Promise<{ providerId: string } | null> {
    for (const [providerId, bot] of this.bots)
      if (bot.meetingId === meetingId) return { providerId };
    return null;
  }
  async join(input: Parameters<MeetingProvider["join"]>[0]): Promise<{ providerId: string }> {
    const existing = await this.lookup(input.meetingId);
    if (existing) return existing;
    const providerId = `emulator-${input.meetingId}`;
    this.bots.set(providerId, {
      meetingId: input.meetingId,
      state: { status: "joining" },
      mediaRemoved: false,
      transcript: [
        {
          speaker: "Alice",
          startMs: 0,
          endMs: 2000,
          text: "We agreed to prepare the launch plan.",
        },
        {
          speaker: "Bob",
          startMs: 2000,
          endMs: 4500,
          text: "I will send the launch plan by Friday.",
        },
      ],
    });
    return { providerId };
  }
  private bot(id: string) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error("Meeting emulator bot not found");
    return bot;
  }
  async get(id: string): Promise<State> {
    const bot = this.bot(id);
    const state = { ...bot.state };
    if (this.options.autoAdvance !== false && state.status !== "failed") this.advance(id);
    return state;
  }
  advance(id: string): void {
    const bot = this.bot(id);
    if (bot.state.status === "failed") return;
    const index = STATES.indexOf(bot.state.status);
    bot.state = { status: STATES[Math.min(index + 1, STATES.length - 1)]! };
  }
  setStatus(id: string, status: State["status"], error?: string): void {
    this.bot(id).state = { status, ...(error ? { error } : {}) };
  }
  setTranscript(id: string, segments: MeetingTranscriptSegment[]): void {
    this.bot(id).transcript = structuredClone(segments);
  }
  async transcript(id: string): Promise<MeetingTranscriptSegment[] | null> {
    const bot = this.bot(id);
    return bot.state.status === "completed" && !bot.mediaRemoved
      ? structuredClone(bot.transcript)
      : null;
  }
  async leave(id: string): Promise<void> {
    const bot = this.bot(id);
    if (bot.state.status !== "failed" && bot.state.status !== "completed")
      bot.state = { status: "processing" };
  }
  async removeMedia(id: string): Promise<void> {
    const bot = this.bot(id);
    bot.mediaRemoved = true;
    bot.transcript = [];
  }
  isMediaRemoved(id: string): boolean {
    return this.bot(id).mediaRemoved;
  }
  parseWebhook(raw: Uint8Array, headers: Headers): { providerId: string } | "ignored" | null {
    return verifyMeetingWebhook(raw, headers, this.webhookSecret, this.options.now?.())
      ? meetingWebhookEvent(raw)
      : null;
  }
  signedWebhook(id: string, event = "bot.status_change"): { raw: Uint8Array; headers: Headers } {
    this.bot(id);
    const raw = new TextEncoder().encode(JSON.stringify({ event, data: { bot: { id } } }));
    const timestamp = String(Math.floor((this.options.now?.() ?? Date.now()) / 1000));
    const messageId = `msg_${id}`;
    const signature = createHmac("sha256", Buffer.from(this.webhookSecret.slice(6), "base64"))
      .update(`${messageId}.${timestamp}.`)
      .update(raw)
      .digest("base64");
    return {
      raw,
      headers: new Headers({
        "webhook-id": messageId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      }),
    };
  }
}
