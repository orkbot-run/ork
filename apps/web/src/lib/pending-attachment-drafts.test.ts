// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import {
  DRAFT_ATTACHMENT_MAX_BYTES,
  writePendingAttachmentDrafts,
} from "./pending-attachment-drafts";

const attachment = (id: string, threadKey = id) => ({
  id,
  threadKey,
  file: new File(["fixture"], "fixture.txt", { type: "text/plain" }),
});
it("refuses more than twenty unsent chats before opening durable storage", async () => {
  await expect(
    writePendingAttachmentDrafts(
      "fixture",
      Array.from({ length: 21 }, (_, index) => attachment(String(index))),
    ),
  ).rejects.toThrow("storage is full");
});
it("refuses duplicate attachment identities and excessive per-chat counts", async () => {
  await expect(
    writePendingAttachmentDrafts("fixture", [attachment("same"), attachment("same")]),
  ).rejects.toThrow("storage is full");
  await expect(
    writePendingAttachmentDrafts(
      "fixture",
      Array.from({ length: 101 }, (_, index) => attachment(String(index), "one-chat")),
    ),
  ).rejects.toThrow("storage is full");
});
it("refuses an oversized replacement before a transaction can overwrite the saved files", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const oversized = new File(
    Array.from({ length: DRAFT_ATTACHMENT_MAX_BYTES / chunk.length + 1 }, () => chunk),
    "large.txt",
  );
  await expect(
    writePendingAttachmentDrafts("fixture", [{ ...attachment("large"), file: oversized }]),
  ).rejects.toThrow("storage is full");
});
