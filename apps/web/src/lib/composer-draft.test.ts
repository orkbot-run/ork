// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; source-owned composer recovery is an Ork addition.

import { describe, expect, it, vi } from "vitest";

import {
  appendComposerDraftText,
  beginComposerDraftSubmission,
  captureComposerDraftSource,
  clearComposerDrafts,
  composerDraftBindingsKey,
  composerDraftStorageKey,
  readComposerDraft,
  readComposerDraftBindings,
  settleComposerDraftSubmission,
  writeComposerDraft,
} from "./composer-draft.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("composer drafts", () => {
  it("scopes stored drafts per thread", () => {
    expect(composerDraftStorageKey("bot:1")).toBe("orkbot.runposerDraft.bot:1");
    expect(composerDraftStorageKey("group:2")).toBe("orkbot.runposerDraft.group:2");
  });

  it("round-trips a draft and clears the key when empty", () => {
    const storage = memoryStorage();
    expect(readComposerDraft("bot:1", storage)).toBe("");
    writeComposerDraft("bot:1", "hello @ada", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("hello @ada");
    expect(readComposerDraft("group:2", storage)).toBe("");
    writeComposerDraft("bot:1", "", storage);
    expect(readComposerDraft("bot:1", storage)).toBe("");
  });

  it("tolerates missing storage", () => {
    expect(readComposerDraft("bot:1", null)).toBe("");
    expect(() => writeComposerDraft("bot:1", "hi", null)).not.toThrow();
  });
  it("keeps raw text and restores exact, versioned occurrence bindings", () => {
    const storage = memoryStorage();
    const bindings = [
      { start: 0, end: 4, mention: { kind: "bot" as const, id: "bot-bob", name: "Bob" } },
      { start: 9, end: 13, mention: { kind: "group" as const, id: "group-bob", name: "Bob" } },
    ];
    writeComposerDraft("thread", "@Bob and @Bob", storage, bindings);
    expect(storage.getItem(composerDraftStorageKey("thread"))).toBe("@Bob and @Bob");
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "@Bob and @Bob", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual(bindings);
    writeComposerDraft("thread", "new text", storage);
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
  });

  it("preserves legacy raw drafts and discards stale or unsupported metadata only", () => {
    const storage = memoryStorage({ [composerDraftStorageKey("thread")]: "@Bob" });
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    for (const record of [
      { version: 1, text: "different", bindings: [] },
      { version: 2, text: "@Bob", bindings: [] },
    ]) {
      storage.setItem(composerDraftBindingsKey("thread"), JSON.stringify(record));
      expect(readComposerDraftBindings("thread", storage)).toEqual([]);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    }
    storage.setItem(composerDraftBindingsKey("thread"), "broken json");
    expect(readComposerDraftBindings("thread", storage)).toEqual([]);
    expect(readComposerDraft("thread", storage)).toBe("@Bob");
  });

  it("does not clear a newer same-text binding written by another tab when a send accepts", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const group = [
        { start: 0, end: 4, mention: { kind: "group" as const, id: "group", name: "Bob" } },
      ];
      const bot = [{ start: 0, end: 4, mention: { kind: "bot" as const, id: "bot", name: "Bob" } }];
      writeComposerDraft("thread", "@Bob", storage, group);
      const submitted = beginComposerDraftSubmission("thread", "@Bob");
      storage.setItem(
        composerDraftBindingsKey("thread"),
        JSON.stringify({ version: 1, text: "@Bob", bindings: bot }),
      );
      settleComposerDraftSubmission("thread", submitted, true);
      expect(readComposerDraft("thread", storage)).toBe("@Bob");
      expect(readComposerDraftBindings("thread", storage)).toEqual(bot);
      const accepted = beginComposerDraftSubmission("thread", "@Bob");
      settleComposerDraftSubmission("thread", accepted, true);
      expect(readComposerDraft("thread", storage)).toBe("");
      expect(storage.getItem(composerDraftBindingsKey("thread"))).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("merges failed source text with newer occurrence bindings and clears only the exact accepted version", () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  try {
    const bob = { kind: "bot" as const, id: "original", name: "Bob" };
    const group = { kind: "group" as const, id: "newer", name: "Bob" };
    writeComposerDraft("source", "@Bob old", storage, [{ start: 0, end: 4, mention: bob }]);
    const attempt = beginComposerDraftSubmission("source", "@Bob old");
    writeComposerDraft("source", "@Bob new", storage, [{ start: 0, end: 4, mention: group }]);
    settleComposerDraftSubmission("source", attempt, false);
    expect(readComposerDraft("source", storage)).toBe("@Bob old\n@Bob new");
    expect(readComposerDraftBindings("source", storage)).toEqual([
      { start: 0, end: 4, mention: bob },
      { start: 9, end: 13, mention: group },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retires source callbacks before wiping drafts, including a later login to the same thread", () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  try {
    const source = captureComposerDraftSource("thread");
    const submission = beginComposerDraftSubmission("thread", "old login");
    clearComposerDrafts();
    writeComposerDraft("thread", "new login");
    appendComposerDraftText(source, "private late transcript");
    settleComposerDraftSubmission("thread", submission, false);
    expect(readComposerDraft("thread")).toBe("new login");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("refuses another window's retired namespace without refreshing a missing nonce", () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  try {
    const source = captureComposerDraftSource("source");
    storage.removeItem("orkbot.composerDraftNamespace");
    appendComposerDraftText(source, "late private text");
    expect(storage.getItem("orkbot.composerDraftNamespace")).toBeNull();
    expect(readComposerDraft("source")).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("retires the durable namespace even if persisting its replacement fails", () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  try {
    const source = captureComposerDraftSource("source");
    const set = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    clearComposerDrafts();
    expect(storage.getItem("orkbot.composerDraftNamespace")).toBeNull();
    set.mockRestore();
    appendComposerDraftText(source, "late private text");
    expect(readComposerDraft("source")).toBe("");
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([true, false])(
  "keeps appended dictation separate from the optimistic pending send (accepted=%s)",
  (accepted) => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    try {
      const source = captureComposerDraftSource("source");
      const attempt = beginComposerDraftSubmission("source", "original submission");
      appendComposerDraftText(source, "new dictation");
      expect(readComposerDraft("source")).toBe("new dictation");
      settleComposerDraftSubmission("source", attempt, accepted);
      expect(readComposerDraft("source")).toBe(
        accepted ? "new dictation" : "original submission\nnew dictation",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
