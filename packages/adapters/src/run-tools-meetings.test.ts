// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingDetail } from "@orkbot/contracts";
import { toolRequiresExplicitApproval, toolResultTaintsRun } from "@orkbot/core";
import { describe, expect, it, vi } from "vitest";
import { createMeeting, getMeeting } from "./meeting-service.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { meetingTools, validateMeetingTool } from "./run-tools-meetings.js";

vi.mock("./meeting-service.js", () => ({
  meetingAvailability: () => ({ enabled: true }),
  getMeeting: vi.fn(),
  createMeeting: vi.fn(),
}));

const privateRun = {
  deps: {},
  run: { spaceId: "space", userId: "owner" },
  bot: { id: "bot" },
  thread: { groupId: null },
  source: { ownerStartedRun: true, messagingChannelRun: false },
} as unknown as RunContext;
const meeting: MeetingDetail = {
  id: "recording",
  botId: "bot",
  title: "Launch",
  platform: "zoom",
  status: "completed",
  createdAt: "2026-11-20T10:00:00Z",
  updatedAt: "2026-11-20T10:00:08Z",
  scheduledAt: null,
  error: null,
  transcript: [
    { speaker: "Alice", startMs: 0, endMs: 2000, text: "We agreed to prepare the launch plan." },
    { speaker: "Bob", startMs: 2000, endMs: 4500, text: "I will send the launch plan by Friday." },
  ],
};

describe("meeting tools", () => {
  it("passes actual speaker and time evidence to the model, scoped to the owner's bot", async () => {
    vi.mocked(getMeeting).mockResolvedValue(meeting);
    const result = await meetingTools.meeting_read!(privateRun, {
      args: { meetingId: "recording", offset: 1 },
    } as unknown as ToolCall);
    expect(getMeeting).toHaveBeenCalledWith(privateRun.deps, privateRun.run, "recording", "bot");
    expect(result).toMatchObject({
      transcript: [meeting.transcript[1]],
      nextOffset: null,
    });
    expect(toolResultTaintsRun("meeting_read")).toBe(true);
  });

  it("refuses shared or autonomous sources before exposing the transcript", () => {
    for (const context of [
      { ...privateRun, thread: { groupId: "shared" } },
      { ...privateRun, source: { ownerStartedRun: false } },
      { ...privateRun, source: { ...privateRun.source, messagingChannelRun: true } },
    ]) {
      expect(validateMeetingTool(context as RunContext, "meeting_read", {})).toMatchObject({
        error: expect.stringContaining("private chat"),
      });
    }
  });

  it("requires explicit approval to schedule a calendar meeting and uses a stable request ID", async () => {
    const args = {
      url: "https://teams.microsoft.com/meet/123456789012",
      title: "Calendar meeting",
      scheduledAt: "2030-05-06T10:30:00Z",
    };
    const finish = vi.fn(async (outcome: unknown) => outcome);
    vi.mocked(createMeeting).mockResolvedValue(meeting);
    expect(toolRequiresExplicitApproval("meeting_schedule")).toBe(true);
    await expect(
      meetingTools.meeting_schedule!(privateRun, { args } as unknown as ToolCall),
    ).resolves.toMatchObject({ error: expect.stringContaining("approve") });
    expect(createMeeting).not.toHaveBeenCalled();
    const approved = {
      args,
      applied: { effect: { id: "effect-1" } },
      finish,
    } as unknown as ToolCall;
    await meetingTools.meeting_schedule!(privateRun, approved);
    await meetingTools.meeting_schedule!(privateRun, approved);
    const requestIds = vi.mocked(createMeeting).mock.calls.map((call) => call[3]);
    expect(requestIds[0]).toMatch(/^meeting_/);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(finish).toHaveBeenCalledWith({ meeting });
  });
});
