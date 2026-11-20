// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MeetingEmulator } from "./meeting-emulator.js";
import { normalizeRecallTranscript, RecallMeetingProvider } from "./recall-meetings.js";

const now = 1_800_000_000_000;
const secret = `whsec_${Buffer.from("test-verification-secret-123456").toString("base64")}`;
const input = {
  meetingId: "meeting-1",
  url: "https://meet.google.com/abc-defg-hij",
  platform: "google_meet" as const,
  botName: "Ork · meeting notes",
  maxSeconds: 3600,
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function provider(fetch: typeof globalThis.fetch) {
  return new RecallMeetingProvider({
    apiKey: "test-key",
    region: "eu-central-1",
    webhookSecret: secret,
    legacyWebhookSecret: secret,
    now: () => now,
    fetch,
  });
}

describe("meeting emulator", () => {
  it("progresses deterministically, reuses a meeting and deletes media", async () => {
    const emulator = new MeetingEmulator();
    const { providerId } = await emulator.join(input);
    expect(await emulator.join(input)).toEqual({ providerId });
    expect(await emulator.transcript(providerId)).toBeNull();
    const states = [];
    for (let index = 0; index < 4; index++) states.push((await emulator.get(providerId)).status);
    expect(states).toEqual(["joining", "recording", "processing", "completed"]);
    expect((await emulator.transcript(providerId))?.map((segment) => segment.speaker)).toEqual([
      "Alice",
      "Bob",
    ]);
    await emulator.removeMedia(providerId);
    expect(await emulator.transcript(providerId)).toBeNull();
    expect(emulator.isMediaRemoved(providerId)).toBe(true);
  });
  it("accepts signed bytes and rejects tampered, expired and missing signatures", async () => {
    const emulator = new MeetingEmulator({ now: () => now });
    const { providerId } = await emulator.join(input);
    const { raw, headers } = emulator.signedWebhook(providerId);
    expect(emulator.parseWebhook(raw, headers)).toEqual({ providerId });
    expect(
      emulator.parseWebhook(new TextEncoder().encode(`${new TextDecoder().decode(raw)} `), headers),
    ).toBeNull();
    headers.set("webhook-timestamp", "1");
    expect(emulator.parseWebhook(raw, headers)).toBeNull();
    expect(emulator.parseWebhook(raw, new Headers())).toBeNull();
  });
  it("supports manual lifecycle and leave", async () => {
    const emulator = new MeetingEmulator({ autoAdvance: false });
    const { providerId } = await emulator.join(input);
    expect(await emulator.get(providerId)).toEqual({ status: "joining" });
    await emulator.leave(providerId);
    expect(await emulator.get(providerId)).toEqual({ status: "processing" });
    emulator.setStatus(providerId, "failed", "denied");
    expect(await emulator.get(providerId)).toEqual({ status: "failed", error: "denied" });
  });
});

describe("Recall meetings", () => {
  it("allows only fixed provider regions", () => {
    expect(
      () =>
        new RecallMeetingProvider({ apiKey: "key", region: "localhost", webhookSecret: secret }),
    ).toThrow("Unsupported Recall region");
  });
  it("creates disclosed audio-only bots with bounded retention and call duration", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ results: [], next: null }))
      .mockResolvedValueOnce(json({ id: "bot-1" }));
    expect(await provider(fetch).join(input)).toEqual({ providerId: "bot-1" });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://eu-central-1.recall.ai/api/v1/bot/");
    const body = JSON.parse(init.body);
    expect(body.recording_config.video_mixed_mp4).toBeNull();
    expect(body.recording_config.audio_mixed_mp3).toEqual({});
    expect(body.recording_config.retention).toEqual({ type: "timed", hours: 24 });
    expect(body.automatic_leave.in_call_recording_timeout).toBe(3600);
    expect(body.bot_name).toBe(input.botName);
    expect(body.chat.on_bot_join.message).toContain("recording audio");
    expect(body.metadata.ork_meeting_id).toBe(input.meetingId);
    expect(init.redirect).toBe("error");
  });
  it("reconciles by metadata without creating duplicates", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json({
        results: [{ id: "existing", metadata: { ork_meeting_id: input.meetingId } }],
        next: null,
      }),
    );
    expect(await provider(fetch).join(input)).toEqual({ providerId: "existing" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toContain("metadata__ork_meeting_id=meeting-1");
  });
  it("never retries an ambiguous create and refuses incomplete lookups", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ results: [], next: null }))
      .mockRejectedValueOnce(new Error("timeout"));
    await expect(provider(fetch).join(input)).rejects.toThrow("timeout");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      provider(vi.fn().mockResolvedValue(json({ results: [], next: "next" }))).lookup("meeting-1"),
    ).rejects.toThrow("incomplete");
  });
  it("supports workspace and legacy signatures and ignores unrelated events", () => {
    const adapter = provider(vi.fn());
    for (const prefix of ["webhook", "svix"]) {
      const raw = new TextEncoder().encode(
        JSON.stringify({ event: "bot.done", data: { bot: { id: "bot-1" } } }),
      );
      const timestamp = String(now / 1000);
      const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`msg_1.${timestamp}.`)
        .update(raw)
        .digest("base64");
      const headers = new Headers({
        [`${prefix}-id`]: "msg_1",
        [`${prefix}-timestamp`]: timestamp,
        [`${prefix}-signature`]: `v1,${signature}`,
      });
      expect(adapter.parseWebhook(raw, headers)).toEqual({ providerId: "bot-1" });
    }
  });
  it("maps status and sends explicit deletion after import", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ status_changes: [{ code: "joining_call" }, { code: "done" }] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const adapter = provider(fetch);
    expect(await adapter.get("bot-1")).toEqual({ status: "completed" });
    await adapter.removeMedia("bot-1");
    expect(fetch.mock.calls[1]![0]).toContain("/bot/bot-1/delete_media/");
    expect(fetch.mock.calls[1]![1].method).toBe("POST");
  });
  it("rejects unsafe transcript destinations before fetching media", async () => {
    for (const downloadUrl of [
      "http://example.com/transcript",
      "https://127.0.0.1/transcript",
      "https://user:password@example.com/transcript",
    ]) {
      const fetch = vi.fn().mockResolvedValue(
        json({
          recordings: [
            {
              media_shortcuts: {
                transcript: { status: { code: "done" }, data: { download_url: downloadUrl } },
              },
            },
          ],
        }),
      );
      await expect(provider(fetch).transcript("bot-1")).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("refuses unknown regions and oversized transcript bodies", () => {
    expect(
      () =>
        new RecallMeetingProvider({ apiKey: "key", region: "localhost", webhookSecret: secret }),
    ).toThrow("region");
    expect(() =>
      normalizeRecallTranscript([
        {
          participant: { name: "Alice" },
          words: [
            {
              text: "x".repeat(4001),
              start_timestamp: { relative: 0 },
              end_timestamp: { relative: 1 },
            },
          ],
        },
      ]),
    ).toThrow();
  });
  it("normalizes speaker-labelled timestamps and rejects malformed or oversized transcripts", () => {
    const segment = {
      participant: { name: "Alice", id: 1 },
      words: [
        { text: "Hello", start_timestamp: { relative: 0.25 }, end_timestamp: { relative: 1.5 } },
      ],
    };
    expect(normalizeRecallTranscript([segment])).toEqual([
      { speaker: "Alice", startMs: 250, endMs: 1500, text: "Hello" },
    ]);
    expect(() => normalizeRecallTranscript([{ words: [] }])).toThrow();
    expect(() => normalizeRecallTranscript(Array(5001).fill(segment))).toThrow();
    expect(() =>
      normalizeRecallTranscript([
        {
          ...segment,
          words: [
            { text: "bad", start_timestamp: { relative: -1 }, end_timestamp: { relative: 0 } },
          ],
        },
      ]),
    ).toThrow();
  });
});
