// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ORPCError } from "@orpc/server";
import type { RouterContext } from "#modules/platform/routes/context";
import { unavailableServerUpdates } from "./service.js";

export function serverUpdateRoutes({ deps, authed }: RouterContext) {
  return {
    serverUpdates: {
      status: authed.serverUpdates.status.handler(
        ({ context }) =>
          deps.serverUpdates?.status({
            userId: context.actor.userId,
            sessionId: context.sessionId,
          }) ?? unavailableServerUpdates(),
      ),
      check: authed.serverUpdates.check.handler(
        ({ context }) =>
          deps.serverUpdates?.check({
            userId: context.actor.userId,
            sessionId: context.sessionId,
          }) ?? unavailableServerUpdates(),
      ),
      apply: authed.serverUpdates.apply.handler(({ context, input }) => {
        if (!deps.serverUpdates) throw new ORPCError("FORBIDDEN");
        return deps.serverUpdates.apply(
          { userId: context.actor.userId, sessionId: context.sessionId },
          input,
        );
      }),
      policy: authed.serverUpdates.policy.handler(({ context, input }) => {
        if (!deps.serverUpdates) throw new ORPCError("FORBIDDEN");
        return deps.serverUpdates.policy(
          { userId: context.actor.userId, sessionId: context.sessionId },
          input,
        );
      }),
    },
  };
}
