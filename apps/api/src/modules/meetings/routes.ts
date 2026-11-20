// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { MeetingDeps } from "@orkbot/adapters";
import {
  createMeeting,
  getMeeting,
  listMeetings,
  MeetingError,
  meetingAvailability,
  queueMeetingWebhook,
  requestMeetingChange,
} from "@orkbot/adapters";
import { ORPCError } from "@orpc/server";
import type { Hono } from "hono";
import { readBoundedBodyBytes } from "#modules/platform/http-body";
import type { RouterContext } from "#modules/platform/routes/context";

export const MEETING_WEBHOOK_PATH = "/api/v1/meetings/webhook";

async function rpc<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof MeetingError) throw new ORPCError(error.code, { message: error.message });
    throw error;
  }
}

export function meetingsRoutes({ authed, deps }: RouterContext) {
  return {
    meetings: {
      status: authed.meetings.status.handler(({ context }) =>
        meetingAvailability(deps.meetings, context.actor.spaceId),
      ),
      list: authed.meetings.list.handler(({ context, input }) =>
        rpc(() => listMeetings(deps, context.actor, input.botId)),
      ),
      get: authed.meetings.get.handler(({ context, input }) =>
        rpc(() => getMeeting(deps, context.actor, input.meetingId)),
      ),
      create: authed.meetings.create.handler(({ context, input }) =>
        rpc(() => createMeeting(deps, context.actor, input)),
      ),
      leave: authed.meetings.leave.handler(({ context, input }) =>
        rpc(async () => {
          await requestMeetingChange(deps, context.actor, input.meetingId, "leave");
          return { ok: true as const };
        }),
      ),
      remove: authed.meetings.remove.handler(({ context, input }) =>
        rpc(async () => {
          await requestMeetingChange(deps, context.actor, input.meetingId, "delete");
          return { ok: true as const };
        }),
      ),
    },
  };
}

export function mountMeetingWebhook(app: Hono, deps: MeetingDeps) {
  const provider = deps.meetings?.provider;
  if (!provider) return;
  app.post(MEETING_WEBHOOK_PATH, async (c) => {
    const raw = await readBoundedBodyBytes(c.req.raw, 256 * 1024);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    const event = provider.parseWebhook(raw, c.req.raw.headers);
    if (!event) return c.json({ error: "Invalid signature" }, 401);
    if (event !== "ignored") await queueMeetingWebhook(deps, event.providerId);
    return c.json({ ok: true });
  });
}
