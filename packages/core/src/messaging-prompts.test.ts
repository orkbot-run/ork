// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors (inherited material)
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 tests are preserved; bounded attachment-label regressions are Ork additions.

import { describe, expect, it } from "vitest";
import { isMessagingChannelRun, unavailableAttachmentLabel } from "./messaging-prompts.js";

describe("isMessagingChannelRun", () => {
  const channelBlock = {
    kind: "channel_message" as const,
    provider: "sendblue",
    channelId: "ch-1",
    fromAddress: "+15551234567",
    fromLabel: "Alice",
    text: "hi",
  };

  it("detects channel runs from the source message blocks", () => {
    expect(isMessagingChannelRun("messaging", [channelBlock])).toBe(true);
    expect(isMessagingChannelRun("messaging", [{ kind: "text", text: "hi" }])).toBe(false);
    expect(isMessagingChannelRun("user", [channelBlock])).toBe(false);
    expect(isMessagingChannelRun("messaging", undefined)).toBe(false);
  });
});

describe("unavailableAttachmentLabel", () => {
  it("keeps failure labels single-line and removes framing, controls and directional overrides", () => {
    expect(
      unavailableAttachmentLabel('bad]\n["instructions"\u0000\u001b\u007f\u0085\u202e].png'),
    ).toBe("[file: bad instructions .png (unavailable)]");
  });
  it.each(["", " \r\n\t", '\u0000\u202e[]"'])(
    "uses the existing unnamed fallback for %j",
    (name) => {
      expect(unavailableAttachmentLabel(name)).toBe("[file (unavailable)]");
    },
  );
  it("bounds the normalized name while preserving ordinary Unicode", () => {
    expect(unavailableAttachmentLabel("  résumé  東京.png  ")).toBe(
      "[file: résumé 東京.png (unavailable)]",
    );
    const label = unavailableAttachmentLabel("界".repeat(1000));
    expect(label).toBe(`[file: ${"界".repeat(64)} (unavailable)]`);
    expect(Buffer.byteLength(label, "utf8")).toBeLessThanOrEqual(214);
  });
});
