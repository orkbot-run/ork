// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { getLogger } from "@orkbot/logging";
import { MeetingEmulator } from "./meeting-emulator.js";
import type { MeetingConnection } from "./meeting-service.js";
import { RecallMeetingProvider } from "./recall-meetings.js";

export function createMeetingConnection(
  source: NodeJS.ProcessEnv = process.env,
): MeetingConnection | null {
  const providerName = source.ORKBOT_MEETING_PROVIDER?.trim();
  if (!providerName || providerName === "none") return null;
  const spaceIds = new Set(
    source.ORKBOT_MEETING_SPACE_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (!spaceIds.size) return null;
  const dailyLimit = boundedInteger(source.ORKBOT_MEETING_DAILY_LIMIT, 10, 100);
  const maxMinutes = boundedInteger(source.ORKBOT_MEETING_MAX_MINUTES, 90, 240);
  if (providerName === "emulator" && source.NODE_ENV !== "production") {
    return {
      provider: new MeetingEmulator({ autoAdvance: true }),
      spaceIds,
      dailyLimit,
      maxMinutes,
      pollMs: 1000,
    };
  }
  if (
    providerName === "recall" &&
    source.ORKBOT_MEETING_API_KEY &&
    source.ORKBOT_MEETING_WEBHOOK_SECRET
  ) {
    try {
      return {
        provider: new RecallMeetingProvider({
          apiKey: source.ORKBOT_MEETING_API_KEY,
          region: source.ORKBOT_MEETING_REGION || "eu-central-1",
          webhookSecret: source.ORKBOT_MEETING_WEBHOOK_SECRET,
          legacyWebhookSecret: source.ORKBOT_MEETING_LEGACY_WEBHOOK_SECRET,
        }),
        spaceIds,
        dailyLimit,
        maxMinutes,
      };
    } catch {
      getLogger().warn("Invalid meeting provider configuration");
      return null;
    }
  }
  getLogger().warn("Meeting provider is unavailable");
  return null;
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}
