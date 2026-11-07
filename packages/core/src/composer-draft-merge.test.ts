// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it } from "vitest";
import { mergeComposerDraftContent } from "./composer-draft-merge.js";

describe("source draft recovery", () => {
  it("keeps same-name mentions bound to their original identities on both sides of a recovery", () => {
    const original = { kind: "bot" as const, id: "original", name: "Alex" };
    const recent = { kind: "group" as const, id: "recent", name: "Alex" };
    expect(
      mergeComposerDraftContent(
        { text: "@Alex first", bindings: [{ start: 0, end: 5, mention: original }] },
        { text: "@Alex newer", bindings: [{ start: 0, end: 5, mention: recent }] },
      ),
    ).toEqual({
      text: "@Alex first\n@Alex newer",
      bindings: [
        { start: 0, end: 5, mention: original },
        { start: 12, end: 17, mention: recent },
      ],
    });
  });

  it("restores an old draft even after the newer field was cleared and rejects stale binding metadata", () => {
    expect(
      mergeComposerDraftContent(
        {
          text: "recover",
          bindings: [{ start: 0, end: 4, mention: { kind: "bot", id: "wrong", name: "Bob" } }],
        },
        { text: "", bindings: [] },
      ),
    ).toEqual({ text: "recover", bindings: [] });
  });
});
