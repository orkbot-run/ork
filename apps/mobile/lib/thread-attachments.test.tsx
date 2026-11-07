// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Durable source ownership regressions follow LICENSE.md.

// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraftScope } from "./composer-draft";
import type { PickedAttachment } from "./pick-attachments";
import { pickDocuments, readSharedFiles } from "./pick-attachments";
import { useIncomingShareImport, useThreadAttachments } from "./thread-attachments";

const state = vi.hoisted(() => ({
  namespace: "login-a",
  failWrite: false,
  records: new Map<string, PickedAttachment[]>(),
  pending: null as null | {
    text: string;
    files: { uri: string; name: string; mimeType: null }[];
    arrivedAt: number;
    generation: number;
    destination?: string;
  },
  listeners: new Set<() => void>(),
  retry: vi.fn(),
  release: vi.fn(),
  insert: vi.fn(),
}));
const scopeKey = (scope: ComposerDraftScope) => JSON.stringify(scope);
vi.mock("./composer-draft", () => ({
  composerDraftScopeKey: (scope: ComposerDraftScope) => JSON.stringify(scope),
  isComposerDraftScopeCurrent: (scope: ComposerDraftScope) => scope.namespace === state.namespace,
}));
vi.mock("./composer-draft-attachments", () => ({
  pinComposerDraft: () => () => undefined,
  pickedAttachmentBytes: () => 2,
  readComposerDraftAttachments: (scope: ComposerDraftScope) =>
    state.records.get(JSON.stringify(scope)) ?? [],
  writeComposerDraftAttachments: (scope: ComposerDraftScope, values: PickedAttachment[]) => {
    if (state.failWrite) return false;
    state.records.set(
      JSON.stringify(scope),
      values.map((item) => ({ ...item })),
    );
    return true;
  },
}));

vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("./pick-attachments", () => ({
  pickDocuments: vi.fn(),
  pickFromLibrary: vi.fn(),
  readDroppedFiles: vi.fn(),
  readSharedFiles: vi.fn(),
  takePhoto: vi.fn(),
}));
vi.mock("./use-file-drop", () => ({ useFileDrop: () => undefined }));
vi.mock("./incoming-share", () => ({
  isIncomingShareCurrent: () => true,
  retryIncomingShare: (share: typeof state.pending) => {
    state.retry(share);
    if (!state.pending) state.pending = share;
    for (const notify of state.listeners) notify();
  },
  takeIncomingShare: (destination: string) => {
    if (!state.pending || (state.pending.destination && state.pending.destination !== destination))
      return null;
    const share = { ...state.pending, destination };
    state.pending = null;
    return share;
  },
  getIncomingShare: () => state.pending,
  subscribeIncomingShare: (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  },
  retainIncomingShareFiles: () => state.release,
}));
vi.mock("./user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));

let root: Root;
let attachments: ReturnType<typeof useThreadAttachments>;

const limits = { maxAttachmentsPerMessage: 4 };
function scopeFor(botId: string): ComposerDraftScope {
  return {
    apiBase: "https://api.example.test",
    userId: "user-a",
    threadKey: `bot:${botId}`,
    namespace: state.namespace,
  };
}
function Probe({ botId, share = false }: { botId: string; share?: boolean }) {
  attachments = useThreadAttachments({
    botId,
    readOnly: false,
    draftScope: scopeFor(botId),
    uploadConfig: limits,
  });
  const ref = { current: { insert: state.insert } } as unknown as Parameters<
    typeof useIncomingShareImport
  >[0]["composerRef"];
  useIncomingShareImport({
    attachments,
    composerRef: ref,
    threadKey: botId,
    readOnly: !share,
    uploadConfig: limits,
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.namespace = "login-a";
  state.failWrite = false;
  state.records.clear();
  state.pending = null;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("counts a read that settles before the next render against the attachment limit", async () => {
  function picked(id: string): PickedAttachment {
    return { id, name: `${id}.txt`, mimeType: "text/plain", contentBase64: "aGk=" };
  }
  function pending(id: string) {
    return { ...picked(id), threadKey: "bot-a" };
  }
  act(() => root.render(<Probe botId="bot-a" />));
  act(() => attachments.setPendingAttachments([pending("a1"), pending("a2"), pending("a3")]));
  type PickResult = {
    attachments: PickedAttachment[];
    skipped: Array<{ name: string; reason: string }>;
  };
  let settleFirst!: (result: PickResult) => void;
  let settleSecond!: (result: PickResult) => void;
  vi.mocked(pickDocuments).mockReturnValueOnce(
    new Promise((resolve) => {
      settleFirst = resolve;
    }),
  );
  vi.mocked(pickDocuments).mockReturnValueOnce(
    new Promise((resolve) => {
      settleSecond = resolve;
    }),
  );
  act(() => attachments.attachFrom("file"));
  act(() => attachments.attachFrom("file"));

  // Both reads settle in the same task, before React commits the first one's attachments.
  await act(async () => {
    settleFirst({ attachments: [picked("d1")], skipped: [] });
    settleSecond({ attachments: [picked("d2")], skipped: [] });
  });

  expect(attachments.activePendingAttachments.map((item) => item.id).sort()).toEqual([
    "a1",
    "a2",
    "a3",
    "d1",
  ]);
  // The identity i18n mock leaves the placeholder; before the fix there was no notice at all.
  expect(attachments.attachmentNotice).toBe("Skipped {items}");
});

function picked(id: string): PickedAttachment {
  return { id, name: `${id}.txt`, mimeType: "text/plain", contentBase64: "aGk=" };
}
function later<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("persists a late picker into its source chat rather than the new active chat", async () => {
  const result = later<{ attachments: PickedAttachment[]; skipped: [] }>();
  vi.mocked(pickDocuments).mockReturnValueOnce(result.promise);
  act(() => root.render(<Probe botId="bot-a" />));
  act(() => attachments.attachFrom("file"));
  act(() => root.render(<Probe botId="bot-b" />));
  await act(async () => result.resolve({ attachments: [picked("late-a")], skipped: [] }));
  expect(attachments.activePendingAttachments).toEqual([]);
  expect(state.records.get(scopeKey(scopeFor("bot-a")))?.map((item) => item.id)).toEqual([
    "late-a",
  ]);
  act(() => root.render(<Probe botId="bot-a" />));
  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["late-a"]);
});

it("does not recreate a retired login's source after an asynchronous picker finishes", async () => {
  const result = later<{ attachments: PickedAttachment[]; skipped: [] }>();
  vi.mocked(pickDocuments).mockReturnValueOnce(result.promise);
  act(() => root.render(<Probe botId="bot-a" />));
  act(() => attachments.attachFrom("file"));
  state.namespace = "login-new";
  act(() => root.render(<Probe botId="bot-a" />));
  await act(async () => result.resolve({ attachments: [picked("stale")], skipped: [] }));
  expect(attachments.activePendingAttachments).toEqual([]);
  expect([...state.records.values()].flat()).toEqual([]);
});

it("keeps immutable source bytes while a captured send waits for durable ownership or ACK", () => {
  act(() => root.render(<Probe botId="bot-a" />));
  const original = { ...picked("send-a"), threadKey: "bot-a" };
  act(() => attachments.setPendingAttachments([original]));
  const settled = attachments.captureForSend(["send-a"]);
  attachments.pendingAttachments[0]!.contentBase64 = "";
  act(() => attachments.setPendingAttachments([]));
  expect(state.records.get(scopeKey(scopeFor("bot-a")))?.[0]?.contentBase64).toBe("aGk=");
  settled();
  settled();
  expect(state.records.get(scopeKey(scopeFor("bot-a")))).toEqual([]);
});

it("requeues an interrupted warm-transition share for its original chat", async () => {
  const result = later<{ attachments: PickedAttachment[]; skipped: []; failedFiles: [] }>();
  state.pending = { text: "shared-a", files: [], arrivedAt: Date.now(), generation: 1 };
  vi.mocked(readSharedFiles)
    .mockReturnValueOnce(result.promise)
    .mockResolvedValueOnce({ attachments: [picked("shared-a")], skipped: [], failedFiles: [] });
  act(() => root.render(<Probe botId="bot-a" share />));
  act(() => root.render(<Probe botId="bot-b" share />));
  await act(async () =>
    result.resolve({ attachments: [picked("discarded-read")], skipped: [], failedFiles: [] }),
  );
  expect(state.pending?.destination).toBe(JSON.stringify(scopeFor("bot-a")));
  expect(attachments.activePendingAttachments).toEqual([]);
  expect(state.insert).not.toHaveBeenCalled();
  act(() => root.render(<Probe botId="bot-a" share />));
  await act(async () => {});
  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual(["shared-a"]);
  expect(state.insert).toHaveBeenCalledWith("shared-a");
});

it("settles shared files against capacity consumed by a picker that finished during the read", async () => {
  const picker = later<{ attachments: PickedAttachment[]; skipped: [] }>();
  const shared = later<{ attachments: PickedAttachment[]; skipped: []; failedFiles: [] }>();
  vi.mocked(pickDocuments).mockReturnValueOnce(picker.promise);
  vi.mocked(readSharedFiles).mockReturnValueOnce(shared.promise);
  act(() => root.render(<Probe botId="bot-a" />));
  act(() =>
    attachments.setPendingAttachments([
      { ...picked("one"), threadKey: "bot-a" },
      { ...picked("two"), threadKey: "bot-a" },
    ]),
  );
  act(() => attachments.attachFrom("file"));
  state.pending = { text: "shared", files: [], arrivedAt: Date.now(), generation: 8 };
  act(() => root.render(<Probe botId="bot-a" share />));
  await act(async () =>
    picker.resolve({ attachments: [picked("three"), picked("four")], skipped: [] }),
  );
  await act(async () =>
    shared.resolve({
      attachments: [picked("overflow-a"), picked("overflow-b")],
      skipped: [],
      failedFiles: [],
    }),
  );
  expect(attachments.activePendingAttachments.map((item) => item.id)).toEqual([
    "one",
    "two",
    "three",
    "four",
  ]);
  expect(state.records.get(scopeKey(scopeFor("bot-a")))).toHaveLength(4);
  expect(attachments.attachmentNotice).toBe("Skipped {items}");
});

it("keeps an unreadable-storage share queued without an immediate retry loop", async () => {
  state.failWrite = true;
  state.pending = { text: "not consumed", files: [], arrivedAt: Date.now(), generation: 10 };
  vi.mocked(readSharedFiles).mockResolvedValueOnce({
    attachments: [picked("retained")],
    skipped: [],
    failedFiles: [],
  });
  await act(async () => root.render(<Probe botId="bot-a" share />));
  expect(attachments.activePendingAttachments).toEqual([]);
  expect(state.insert).not.toHaveBeenCalled();
  expect(state.pending?.text).toBe("not consumed");
  expect(readSharedFiles).toHaveBeenCalledTimes(1);
  expect(attachments.attachmentNotice).toBe("Could not attach files");
});

it("does not requeue or insert a share that completed after explicit logout", async () => {
  const shared = later<{ attachments: PickedAttachment[]; skipped: []; failedFiles: [] }>();
  state.pending = { text: "private old source", files: [], arrivedAt: Date.now(), generation: 11 };
  vi.mocked(readSharedFiles).mockReturnValueOnce(shared.promise);
  act(() => root.render(<Probe botId="bot-a" share />));
  state.namespace = "new-login";
  act(() => root.render(<Probe botId="bot-a" share />));
  await act(async () =>
    shared.resolve({ attachments: [picked("retired")], skipped: [], failedFiles: [] }),
  );
  expect(attachments.pendingAttachments).toEqual([]);
  expect(state.retry).not.toHaveBeenCalled();
  expect(state.insert).not.toHaveBeenCalled();
  expect([...state.records.values()].flat()).toEqual([]);
});
