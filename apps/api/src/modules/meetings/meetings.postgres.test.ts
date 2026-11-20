// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { BackgroundJob, JobPublisher } from "@orkbot/adapter-kit";
import {
  createMeeting,
  getMeeting,
  listMeetings,
  MeetingEmulator,
  meetingAvailability,
  pollMeeting,
  reconcileMeetings,
  requestMeetingChange,
} from "@orkbot/adapters";
import { asSystem, createDb, LocalKeyProvider, runAsTenant } from "@orkbot/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MEETING_WEBHOOK_PATH, mountMeetingWebhook } from "./routes.js";

const postgres = process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

postgres("meeting lifecycle with tenant enforcement", () => {
  const stamp = Date.now().toString(36);
  const owner = { spaceId: `meeting-space-${stamp}`, userId: `meeting-owner-${stamp}` };
  const peer = { ...owner, userId: `meeting-peer-${stamp}` };
  const organizationId = `meeting-org-${stamp}`;
  const botId = `meeting-bot-${stamp}`;
  const emulator = new MeetingEmulator({ autoAdvance: false });
  const queued: BackgroundJob[] = [];
  const jobs: JobPublisher = {
    async enqueue(job) {
      queued.push(job);
    },
    async cancel() {},
    async close() {},
  };
  let db: ReturnType<typeof createDb>;
  const connection = {
    provider: emulator,
    spaceIds: new Set([owner.spaceId]),
    dailyLimit: 2,
    maxMinutes: 1,
    pollMs: 50,
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, {
      keyProvider: new LocalKeyProvider([{ id: "meetings-test", key: Buffer.alloc(32, 11) }]),
      encryptContent: true,
    });
    const sys = asSystem(db.prisma);
    for (const userId of [owner.userId, peer.userId]) {
      await sys.user.create({
        data: { id: userId, name: userId, email: `${userId}@example.test` },
      });
    }
    await sys.organization.create({
      data: { id: organizationId, name: "Meetings", slug: organizationId, createdAt: new Date() },
    });
    await sys.space.create({
      data: { id: owner.spaceId, organizationId, name: "Meetings", isDefault: true },
    });
    await sys.bot.create({
      data: {
        id: botId,
        spaceId: owner.spaceId,
        userId: owner.userId,
        name: "Chief",
        description: "",
        instructions: "",
        color: "purple",
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    const sys = asSystem(db.prisma);
    await sys.organization.deleteMany({ where: { id: organizationId } });
    await sys.user.deleteMany({ where: { id: { in: [owner.userId, peer.userId] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  const deps = () => ({ prisma: db.prisma, jobs, meetings: connection });
  const run = <T>(work: () => Promise<T>) => runAsTenant(owner, work);
  const forceDue = (id: string) =>
    asSystem(db.prisma).meetingSession.update({
      where: { id },
      data: { nextCheckAt: new Date() },
    });
  const input = {
    botId,
    url: "https://zoom.us/j/12345678901?pwd=meeting-only",
    confirmed: true as const,
  };

  it("enforces consent and scope, imports a speaker-labelled transcript, and removes both copies", async () => {
    expect(meetingAvailability(null, owner.spaceId)).toMatchObject({ enabled: false });
    expect(meetingAvailability(connection, "other")).toMatchObject({ enabled: false });
    await expect(
      run(() =>
        createMeeting(deps(), owner, {
          ...input,
          url: "https://zoom.us.example.test/j/12345678901",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      run(() => createMeeting({ ...deps(), meetings: null }, owner, input)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const created = await run(() =>
      createMeeting(deps(), owner, { ...input, title: "Launch plan" }),
    );
    expect(created).toMatchObject({ status: "joining", platform: "zoom" });
    await expect(
      runAsTenant(peer, () => getMeeting(deps(), peer, created.id)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const initial = await asSystem(db.prisma).$queryRaw<Array<{ title: string; url: string }>>`
      SELECT title, url FROM meeting_sessions WHERE id = ${created.id}`;
    expect(initial[0]?.title).toMatch(/^rkz1:/);
    expect(initial[0]?.url).toMatch(/^rkz1:/);
    expect(initial[0]?.url).not.toContain("meeting-only");

    await run(() => pollMeeting(deps(), created.id));
    const registered = await asSystem(db.prisma).meetingSession.findUniqueOrThrow({
      where: { id: created.id },
    });
    const providerId = registered.providerId!;
    expect(providerId).toBeTruthy();
    expect(registered.url).toBeNull();

    const app = new Hono();
    mountMeetingWebhook(app, deps());
    const signed = emulator.signedWebhook(providerId, "bot.in_call_recording");
    const rejected = await app.request(MEETING_WEBHOOK_PATH, {
      method: "POST",
      body: Buffer.from(signed.raw),
    });
    expect(rejected.status).toBe(401);
    emulator.advance(providerId);
    expect(
      (
        await app.request(MEETING_WEBHOOK_PATH, {
          method: "POST",
          body: Buffer.from(signed.raw),
          headers: signed.headers,
        })
      ).status,
    ).toBe(200);
    await run(() => pollMeeting(deps(), created.id));
    await expect(run(() => getMeeting(deps(), owner, created.id))).resolves.toMatchObject({
      status: "recording",
    });

    await run(() => requestMeetingChange(deps(), owner, created.id, "leave"));
    await run(() => pollMeeting(deps(), created.id));
    emulator.advance(providerId);
    await forceDue(created.id);
    await run(() => pollMeeting(deps(), created.id));
    const completed = await run(() => getMeeting(deps(), owner, created.id));
    expect(completed.status).toBe("completed");
    expect(completed.transcript).toEqual([
      expect.objectContaining({ speaker: "Alice", text: expect.stringContaining("launch plan") }),
      expect.objectContaining({ speaker: "Bob", text: expect.stringContaining("Friday") }),
    ]);
    const raw = await asSystem(db.prisma).$queryRaw<Array<{ transcript: string }>>`
      SELECT transcript FROM meeting_sessions WHERE id = ${created.id}`;
    expect(raw[0]?.transcript).toMatch(/^rkz1:/);
    expect(raw[0]?.transcript).not.toContain("Alice");
    await run(() => pollMeeting(deps(), created.id));
    expect(emulator.isMediaRemoved(providerId)).toBe(true);

    await run(() => requestMeetingChange(deps(), owner, created.id, "delete"));
    await expect(run(() => listMeetings(deps(), owner, botId))).resolves.toEqual([]);
    await run(() => pollMeeting(deps(), created.id));
    await expect(
      asSystem(db.prisma).meetingSession.count({ where: { id: created.id } }),
    ).resolves.toBe(0);
  });

  it("recovers a lost enqueue and an ambiguous join without charging the daily limit again", async () => {
    const joinNormally = emulator.join.bind(emulator);
    const join = vi.spyOn(emulator, "join");
    join.mockImplementationOnce(async (input) => {
      await joinNormally.call(emulator, input);
      throw new Error("Transport interrupted after creation");
    });
    try {
      const created = await run(() => createMeeting(deps(), owner, input, "meeting-idempotent"));
      expect(await run(() => createMeeting(deps(), owner, input, "meeting-idempotent"))).toEqual(
        created,
      );
      await expect(run(() => createMeeting(deps(), owner, input))).rejects.toMatchObject({
        code: "CONFLICT",
      });
      queued.length = 0;
      await reconcileMeetings(deps());
      expect(queued).toContainEqual(
        expect.objectContaining({ name: "meeting.poll", payload: { meetingId: created.id } }),
      );
      await run(() => pollMeeting(deps(), created.id));
      await forceDue(created.id);
      await run(() => pollMeeting(deps(), created.id));
      expect(join).toHaveBeenCalledTimes(1);
      await expect(emulator.lookup(created.id)).resolves.toMatchObject({
        providerId: expect.any(String),
      });
      const set = await asSystem(db.prisma).meetingSession.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(set.providerId).toBeTruthy();
      // The local watchdog requests departure even if a provider never reports the limit.
      emulator.setStatus(set.providerId!, "recording");
      await asSystem(db.prisma).meetingSession.update({
        where: { id: created.id },
        data: { startsAt: new Date(Date.now() - 61_000), nextCheckAt: new Date() },
      });
      await run(() => pollMeeting(deps(), created.id));
      await expect(emulator.get(set.providerId!)).resolves.toMatchObject({ status: "processing" });
    } finally {
      join.mockRestore();
    }
  });
});
