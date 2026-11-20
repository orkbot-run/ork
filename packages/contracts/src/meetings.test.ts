// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { CreateMeetingInputSchema, parseMeetingLink } from "./meetings.js";

describe("meeting links", () => {
  it.each([
    ["https://meet.google.com/abc-defg-hij", "google_meet"],
    ["https://example.zoom.us/j/12345678901?pwd=invitation", "zoom"],
    ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0", "microsoft_teams"],
    ["https://teams.live.com/meet/1234567890123?p=example", "microsoft_teams"],
  ])("recognizes %s", (url, platform) => {
    expect(parseMeetingLink(url)).toEqual({ url, platform });
  });

  it.each([
    "http://meet.google.com/abc-defg-hij",
    "https://meet.google.com.example.org/abc-defg-hij",
    "https://meet.google.com:444/abc-defg-hij",
    "https://user:pass@zoom.us/j/12345678901",
    "https://teams.microsoft.com/share/123456789012",
    "https://zoom.us/j/incorrect",
  ])("rejects %s", (url) => {
    expect(parseMeetingLink(url)).toBeNull();
  });

  it("requires a positive confirmation before a meeting can be created", () => {
    expect(
      CreateMeetingInputSchema.safeParse({
        botId: "fixture",
        url: "https://meet.google.com/abc-defg-hij",
        confirmed: false,
      }).success,
    ).toBe(false);
  });
});
