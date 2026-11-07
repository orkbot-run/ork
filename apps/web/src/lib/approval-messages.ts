// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { i18n } from "@lingui/core";
import type { AiDataUse, ApprovalReason } from "@orkbot/contracts";

/** Static renderer descriptors keep shared backend messages visible to Lingui extraction. */
export function translateApprovalReason(reason: ApprovalReason): string {
  switch (reason) {
    case "scheduled_command":
      return i18n._({
        id: "Scheduling a command requires approval.",
        message: "Scheduling a command requires approval.",
      });
    case "outside_content_schedule":
      return i18n._({
        id: "Adding routine destinations from outside content requires approval.",
        message: "Adding routine destinations from outside content requires approval.",
      });
    case "webhook_trigger":
      return i18n._({
        id: "Webhook-triggered actions require approval.",
        message: "Webhook-triggered actions require approval.",
      });
  }
}

export function translateAiDataDisclosure(use: AiDataUse): string {
  switch (use) {
    case "model":
      return i18n._({
        id: "Messages, chat history, bot instructions, memories, attachments, screenshots and connected-app content are sent to run your bots, including routines.",
        message:
          "Messages, chat history, bot instructions, memories, attachments, screenshots and connected-app content are sent to run your bots, including routines.",
      });
    case "voice":
      return i18n._({
        id: "Your recordings are sent for transcription, and text you play is sent to generate speech.",
        message:
          "Your recordings are sent for transcription, and text you play is sent to generate speech.",
      });
    case "memory":
      return i18n._({
        id: "Conversation summaries, memories, searches and bot and Space IDs are sent to store and recall context.",
        message:
          "Conversation summaries, memories, searches and bot and Space IDs are sent to store and recall context.",
      });
  }
}
