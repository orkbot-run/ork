// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import * as z from "zod";

export const RoutineMessageProviderSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9._-]+$/i);

/** Validate the resolved trigger configuration, after merging partial updates. */
export function routineTriggerIssue(value: {
  crons: readonly string[];
  webhookEnabled?: boolean;
  githubEnabled?: boolean;
  messageProvider?: string | null;
  watch?: unknown;
}): { message: string; path: "crons" | "watch" } | undefined {
  if (value.watch && value.crons.length > 0) {
    return {
      message: "A change trigger checks on its own interval; remove the schedule",
      path: "watch",
    };
  }
  if (
    !value.crons.length &&
    !value.webhookEnabled &&
    !value.githubEnabled &&
    !value.messageProvider &&
    !value.watch
  ) {
    return {
      message: "Add a schedule, webhook, GitHub, message, or change trigger",
      path: "crons",
    };
  }
  return undefined;
}
