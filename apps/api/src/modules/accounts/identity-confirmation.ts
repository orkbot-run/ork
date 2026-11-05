// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import type { Auth } from "@orkbot/auth";
import type { Actor } from "@orkbot/contracts";
import { IDENTITY_CONFIRMATION_REQUIRED } from "@orkbot/contracts";
import { ORPCError } from "@orpc/server";

/**
 * Guards a procedure that reveals sensitive data: the calling session must have confirmed its
 * identity within the last few minutes. Clients answer the error by confirming, then retrying.
 */
export async function requireIdentityConfirmation(
  auth: Pick<Auth, "hasRecentIdentityConfirmation">,
  context: { actor: Actor | null; sessionId?: string },
): Promise<void> {
  if (
    context.actor &&
    context.sessionId &&
    (await auth.hasRecentIdentityConfirmation({
      sessionId: context.sessionId,
      userId: context.actor.userId,
    }))
  )
    return;
  throw new ORPCError(IDENTITY_CONFIRMATION_REQUIRED, {
    status: 403,
    message: "Confirm it's you",
  });
}
