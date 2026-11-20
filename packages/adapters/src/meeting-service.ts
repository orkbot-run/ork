// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { randomUUID } from "node:crypto";
import type { JobPublisher, MeetingProvider } from "@orkbot/adapter-kit";
import { meetingPollJob } from "@orkbot/adapter-kit";
import type { Actor, CreateMeetingInput, MeetingSummary } from "@orkbot/contracts";
import {
  MeetingSummarySchema,
  MeetingTranscriptSchema,
  parseMeetingLink,
  UNSUPPORTED_MEETING_LINK,
} from "@orkbot/contracts";
import type { MeetingSession, Prisma, PrismaClient } from "@orkbot/db";
import { isUniqueViolation, runAsSystem } from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import { notificationIdentity } from "./notification-identity.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_SCHEDULE_AHEAD = 30 * DAY;
const JOIN_WINDOW = 5 * MINUTE;
const IMPORT_WINDOW = 45 * MINUTE;
const LEASE = 2 * MINUTE;
const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_MAX_MINUTES = 90;
const INACTIVE = ["completed", "failed", "canceled"];

export interface MeetingConnection {
  provider: MeetingProvider;
  spaceIds: ReadonlySet<string>;
  dailyLimit: number;
  maxMinutes: number;
  pollMs?: number;
}

export interface MeetingDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
  meetings?: MeetingConnection | null;
}

type MeetingActor = Pick<Actor, "spaceId" | "userId">;

export class MeetingError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export function meetingAvailability(
  connection: MeetingConnection | null | undefined,
  spaceId: string,
) {
  return {
    enabled: Boolean(connection?.spaceIds.has("*") || connection?.spaceIds.has(spaceId)),
    dailyLimit: connection?.dailyLimit ?? DEFAULT_DAILY_LIMIT,
    maxMinutes: connection?.maxMinutes ?? DEFAULT_MAX_MINUTES,
  };
}

function enabled(deps: MeetingDeps, spaceId: string): MeetingConnection {
  if (!deps.meetings || !meetingAvailability(deps.meetings, spaceId).enabled)
    throw new MeetingError("NOT_FOUND", "Meetings are unavailable in this space.");
  return deps.meetings;
}

export function summarizeMeeting(
  row: Pick<
    MeetingSession,
    | "id"
    | "botId"
    | "title"
    | "platform"
    | "status"
    | "scheduledAt"
    | "createdAt"
    | "updatedAt"
    | "error"
  >,
): MeetingSummary {
  return MeetingSummarySchema.parse({
    id: row.id,
    botId: row.botId,
    title: row.title,
    platform: row.platform,
    status: row.status,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    error: row.error,
  });
}

function meetingScope(actor: MeetingActor) {
  return { spaceId: actor.spaceId, userId: actor.userId, deleteRequestedAt: null };
}

async function enqueue(deps: MeetingDeps, meetingId: string, at: Date, keepExisting = false) {
  await deps.jobs.enqueue(meetingPollJob(meetingId, at, keepExisting)).catch(() => {
    // The session is the durable record. The job reconciler will recover this wakeup.
    getLogger().warn("Meeting wakeup enqueue failed", { "meeting.id": meetingId });
  });
}

export async function createMeeting(
  deps: MeetingDeps,
  actor: MeetingActor,
  input: CreateMeetingInput,
  id: string = randomUUID(),
) {
  const connection = enabled(deps, actor.spaceId);
  if (!input.confirmed) throw new MeetingError("BAD_REQUEST", "Confirm permission to record.");
  const link = parseMeetingLink(input.url);
  if (!link) throw new MeetingError("BAD_REQUEST", UNSUPPORTED_MEETING_LINK);
  const existing = () =>
    deps.prisma.meetingSession.findFirst({
      where: { ...meetingScope(actor), id, botId: input.botId },
    });
  const previous = await existing();
  if (previous) return summarizeMeeting(previous);
  const now = new Date();
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (
    scheduledAt &&
    (!Number.isFinite(scheduledAt.getTime()) ||
      +scheduledAt <= +now ||
      +scheduledAt > +now + MAX_SCHEDULE_AHEAD)
  ) {
    throw new MeetingError("BAD_REQUEST", "Schedule the meeting within the next 30 days.");
  }
  const startsAt = scheduledAt ?? now;
  const row = await deps.prisma
    .$transaction(async (tx) => {
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
        select: { id: true },
      });
      if (!bot) throw new MeetingError("NOT_FOUND", "Bot not found.");
      const day = startsAt.toISOString().slice(0, 10);
      const slot = await tx.$queryRaw<Array<{ used: number }>>`
      INSERT INTO "meeting_daily_usage" ("spaceId", "day", "used")
      VALUES (${actor.spaceId}, ${day}::date, 1)
      ON CONFLICT ("spaceId", "day") DO UPDATE
      SET "used" = "meeting_daily_usage"."used" + 1
      WHERE "meeting_daily_usage"."used" < ${connection.dailyLimit}
      RETURNING "used"`;
      if (!slot.length)
        throw new MeetingError("CONFLICT", "This space has reached its daily meeting limit.");
      return tx.meetingSession.create({
        data: {
          id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId: input.botId,
          url: link.url,
          title: input.title?.trim() || "Meeting",
          platform: link.platform,
          status: scheduledAt ? "scheduled" : "joining",
          scheduledAt,
          consentedAt: now,
          startsAt,
          nextCheckAt: startsAt,
          deadlineAt: new Date(+startsAt + connection.maxMinutes * MINUTE + IMPORT_WINDOW),
        },
      });
    })
    .catch(async (error: unknown) => {
      if (
        !isUniqueViolation(error) &&
        !(error instanceof MeetingError && error.code === "CONFLICT")
      )
        throw error;
      const current = await existing();
      if (!current) throw error;
      return current;
    });
  if (row.nextCheckAt) await enqueue(deps, row.id, row.nextCheckAt, true);
  return summarizeMeeting(row);
}

export async function listMeetings(deps: MeetingDeps, actor: MeetingActor, botId: string) {
  enabled(deps, actor.spaceId);
  const rows = await deps.prisma.meetingSession.findMany({
    where: { ...meetingScope(actor), botId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 40,
    omit: { url: true, transcript: true },
  });
  return rows.map(summarizeMeeting);
}

export async function getMeeting(
  deps: MeetingDeps,
  actor: MeetingActor,
  meetingId: string,
  botId?: string,
) {
  enabled(deps, actor.spaceId);
  const row = await deps.prisma.meetingSession.findFirst({
    where: { ...meetingScope(actor), id: meetingId, ...(botId ? { botId } : {}) },
    omit: { url: true },
  });
  if (!row) throw new MeetingError("NOT_FOUND", "Meeting not found.");
  return {
    ...summarizeMeeting(row),
    transcript: row.transcript ? MeetingTranscriptSchema.parse(JSON.parse(row.transcript)) : [],
  };
}

export async function requestMeetingChange(
  deps: MeetingDeps,
  actor: MeetingActor,
  meetingId: string,
  action: "leave" | "delete",
) {
  const now = new Date();
  const existing = await deps.prisma.meetingSession.findFirst({
    where: { ...meetingScope(actor), id: meetingId },
    select: { id: true, status: true },
  });
  if (!existing) throw new MeetingError("NOT_FOUND", "Meeting not found.");
  if (action === "leave" && INACTIVE.includes(existing.status)) return;
  const changed = await deps.prisma.meetingSession.updateMany({
    where: { ...meetingScope(actor), id: meetingId },
    data: {
      ...(action === "delete"
        ? { deleteRequestedAt: now, title: "", url: null, transcript: null }
        : { leaveRequestedAt: now }),
      nextCheckAt: now,
    },
  });
  if (changed.count) await enqueue(deps, meetingId, now);
}

export async function queueMeetingWebhook(deps: MeetingDeps, providerId: string) {
  if (!deps.meetings) return;
  const now = new Date();
  const id = await runAsSystem("resolve a verified external meeting event", async () => {
    const row = await deps.prisma.meetingSession.findUnique({
      where: { providerId },
      select: { id: true, nextCheckAt: true },
    });
    if (!row?.nextCheckAt) return undefined;
    await deps.prisma.meetingSession.updateMany({
      where: { id: row.id, nextCheckAt: { gt: now } },
      data: { nextCheckAt: now },
    });
    return row.id;
  });
  if (id) await enqueue(deps, id, now);
}

type Work = MeetingSession & {
  bot: {
    id: string;
    name: string;
    color: string;
    avatarSet: string | null;
    avatarSeed: string | null;
    archivedAt: Date | null;
  };
};

async function runMeetingWork(
  deps: MeetingDeps,
  connection: MeetingConnection,
  row: Work,
  token: string,
) {
  const now = new Date();
  const poll = new Date(+now + (connection.pollMs ?? 12_000));
  const stopped =
    row.leaveRequestedAt ||
    row.deleteRequestedAt ||
    row.bot.archivedAt ||
    !meetingAvailability(connection, row.spaceId).enabled;
  const write = (data: Prisma.MeetingSessionUpdateManyMutationInput) =>
    deps.prisma.meetingSession.updateMany({ where: { id: row.id, leaseToken: token }, data });
  const erase = () =>
    deps.prisma.meetingSession.deleteMany({ where: { id: row.id, leaseToken: token } });
  const finished = (status: "failed" | "canceled", error: string | null) =>
    write({ status, error, url: null, nextCheckAt: row.providerId ? now : null });

  if (!row.providerId) {
    if (row.joinAttemptedAt) {
      const found = await connection.provider.lookup?.(row.id);
      if (found) {
        await write({ providerId: found.providerId, url: null, nextCheckAt: now });
      } else if (+now < +row.joinAttemptedAt + JOIN_WINDOW) {
        await write({ nextCheckAt: poll });
      } else if (row.deleteRequestedAt) {
        await erase();
      } else {
        await finished(
          stopped ? "canceled" : "failed",
          stopped ? null : "The bot could not join the meeting.",
        );
      }
      return;
    }
    if (row.deleteRequestedAt) {
      await erase();
      return;
    }
    if (stopped || +now >= +row.startsAt + JOIN_WINDOW) {
      await finished(
        stopped ? "canceled" : "failed",
        stopped ? null : "The scheduled join time has passed.",
      );
      return;
    }
    if (!row.url || +row.startsAt > +now) {
      await write({ nextCheckAt: row.startsAt });
      return;
    }
    const identity = await notificationIdentity(row.bot);
    // Record intent before the network call. An ambiguous create can only be looked up.
    const joining = await deps.prisma.meetingSession.updateMany({
      where: {
        id: row.id,
        leaseToken: token,
        joinAttemptedAt: null,
        leaveRequestedAt: null,
        deleteRequestedAt: null,
        bot: { archivedAt: null },
      },
      data: { status: "joining", joinAttemptedAt: now, nextCheckAt: poll },
    });
    if (!joining.count) return;
    const platform = parseMeetingLink(row.url)?.platform;
    if (!platform) {
      await finished("failed", UNSUPPORTED_MEETING_LINK);
      return;
    }
    const { providerId } = await connection.provider.join({
      meetingId: row.id,
      url: row.url,
      platform,
      botName: identity.name,
      maxSeconds: connection.maxMinutes * 60,
      avatarBase64: identity.avatar,
    });
    await write({ providerId, url: null, nextCheckAt: poll });
    return;
  }

  const remoteId = row.providerId;
  if (INACTIVE.includes(row.status) && !row.deleteRequestedAt) {
    if (!row.mediaDeletedAt) await connection.provider.removeMedia(remoteId);
    await write({ mediaDeletedAt: now, nextCheckAt: null });
    return;
  }
  const state = await connection.provider.get(remoteId);
  const recording = state.status === "joining" || state.status === "recording";
  if (recording && (stopped || +now >= +row.startsAt + connection.maxMinutes * MINUTE)) {
    if (!row.leaveSentAt || +now - +row.leaveSentAt >= MINUTE) {
      await connection.provider.leave(remoteId);
      await write({ status: "processing", leaveSentAt: now, nextCheckAt: poll });
    } else {
      await write({ nextCheckAt: poll });
    }
    return;
  }

  if (row.deleteRequestedAt) {
    if (!row.mediaDeletedAt || state.status !== "completed") {
      // A final check after processing ensures late provider media isn't left behind.
      if (state.status === "processing" && +now < +row.deadlineAt) {
        await write({ nextCheckAt: poll });
        return;
      }
      await connection.provider.removeMedia(remoteId);
    }
    await erase();
    return;
  }

  if (state.status === "failed" || +now >= +row.deadlineAt) {
    await finished("failed", "The meeting could not be recorded or transcribed.");
    return;
  }
  if (state.status !== "completed") {
    await write({ status: row.leaveSentAt ? "processing" : state.status, nextCheckAt: poll });
    return;
  }
  const transcript = await connection.provider.transcript(remoteId);
  if (transcript === null) {
    await write({ status: "processing", nextCheckAt: poll });
    return;
  }
  const serialized = JSON.stringify(MeetingTranscriptSchema.parse(transcript));
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) {
    await finished("failed", "The meeting transcript exceeded the supported size.");
    return;
  }
  await deps.prisma.meetingSession.updateMany({
    where: { id: row.id, leaseToken: token, deleteRequestedAt: null },
    data: { status: "completed", transcript: serialized, nextCheckAt: now },
  });
}

export async function pollMeeting(deps: MeetingDeps, meetingId: string) {
  const connection = deps.meetings;
  if (!connection) return;
  const now = new Date();
  const leaseToken = randomUUID();
  const claimed = await deps.prisma.meetingSession.updateMany({
    where: {
      id: meetingId,
      nextCheckAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    },
    data: { leaseToken, leaseUntil: new Date(+now + LEASE) },
  });
  if (!claimed.count) return;
  try {
    const row = await deps.prisma.meetingSession.findUnique({
      where: { id: meetingId },
      include: {
        bot: {
          select: {
            id: true,
            name: true,
            color: true,
            avatarSet: true,
            avatarSeed: true,
            archivedAt: true,
          },
        },
      },
    });
    if (row?.leaseToken === leaseToken) await runMeetingWork(deps, connection, row, leaseToken);
  } catch {
    // Provider errors can contain meeting URLs and access credentials. Keep diagnostics scoped.
    getLogger().warn("Meeting provider operation failed", { "meeting.id": meetingId });
    await deps.prisma.meetingSession.updateMany({
      where: { id: meetingId, leaseToken },
      data: { nextCheckAt: new Date(Date.now() + Math.max(1000, connection.pollMs ?? 30_000)) },
    });
  } finally {
    await deps.prisma.meetingSession.updateMany({
      where: { id: meetingId, leaseToken },
      data: { leaseToken: null, leaseUntil: null },
    });
  }
  const pending = await deps.prisma.meetingSession.findUnique({
    where: { id: meetingId },
    select: { nextCheckAt: true },
  });
  if (pending?.nextCheckAt) await enqueue(deps, meetingId, pending.nextCheckAt);
}

export async function reconcileMeetings(deps: MeetingDeps) {
  if (!deps.meetings) return;
  const now = new Date();
  const missing = await runAsSystem("recover pending meeting wakeups", () =>
    deps.prisma.meetingSession.findMany({
      where: {
        nextCheckAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      select: { id: true, nextCheckAt: true },
      orderBy: [{ nextCheckAt: "asc" }, { id: "asc" }],
      take: 100,
    }),
  );
  await Promise.all(missing.map((row) => enqueue(deps, row.id, row.nextCheckAt ?? now, true)));
}
