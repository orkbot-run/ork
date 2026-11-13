// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingAttachment } from "../pages/shell/chat-shared";
import { clearComposerDrafts } from "./composer-draft";
import { usePendingAttachmentDrafts } from "./use-pending-attachment-drafts";

const disk = vi.hoisted(() => ({
  items: new Map<string, PendingAttachment[]>(),
  read: vi.fn<(scope: string) => Promise<PendingAttachment[]>>(),
  write: vi.fn<(scope: string, items: PendingAttachment[]) => Promise<void>>(),
}));
vi.mock("./pending-attachment-drafts", () => ({
  pinPendingAttachmentDrafts: () => () => undefined,
  readPendingAttachmentDrafts: (scope: string) => disk.read(scope),
  writePendingAttachmentDrafts: (scope: string, items: PendingAttachment[]) =>
    disk.write(scope, items),
  clearPendingAttachmentDrafts: async (namespace: string) => {
    for (const scope of disk.items.keys())
      if (JSON.parse(scope)[0] === namespace) disk.items.delete(scope);
  },
}));
let root: Root;
let current: ReturnType<typeof usePendingAttachmentDrafts>;
function Harness({ space, user = "user-a" }: { space: string; user?: string }) {
  current = usePendingAttachmentDrafts(space, user);
  return null;
}
const file = (id: string): PendingAttachment => ({
  id,
  threadKey: "same-chat-id",
  file: new File([`${id} bytes`], `${id}.txt`, { type: "text/plain" }),
});
async function show(space: string, user?: string) {
  await act(async () => root.render(<Harness space={space} user={user} />));
}
async function reopen(space: string, user?: string) {
  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));
  await show(space, user);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  disk.items.clear();
  disk.read.mockReset().mockImplementation(async (scope) => disk.items.get(scope) ?? []);
  disk.write.mockReset().mockImplementation(async (scope, items) => {
    disk.items.set(scope, [...items]);
  });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("restores each workspace's picked File after A-to-B-to-A renderer remounts and isolates accounts", async () => {
  await show("a");
  await act(async () => current[1]([file("a")]));
  await reopen("b");
  expect(current[0]).toEqual([]);
  await act(async () => current[1]([file("b")]));
  await reopen("a");
  expect(current[0].map((item) => item.id)).toEqual(["a"]);
  expect(current[0][0]?.file).toBeInstanceOf(File);
  const text = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsText(current[0][0]!.file);
  });
  expect(text).toBe("a bytes");
  await reopen("a", "user-b");
  expect(current[0]).toEqual([]);
  await reopen("b");
  expect(current[0].map((item) => item.id)).toEqual(["b"]);
});

it("does not apply a delayed old workspace read after selecting another workspace", async () => {
  let finish!: (items: PendingAttachment[]) => void;
  disk.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await show("a");
  await show("b");
  await act(async () => current[1]([file("b")]));
  await act(async () => finish([file("a")]));
  expect(current[0].map((item) => item.id)).toEqual(["b"]);
});

it("merges an early new pick with the restored files without overwriting either", async () => {
  let finish!: (items: PendingAttachment[]) => void;
  disk.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await show("a");
  await act(async () => current[1]([file("new")]));
  await act(async () => finish([file("saved")]));
  expect(current[0].map((item) => item.id)).toEqual(["saved", "new"]);
  expect([...disk.items.values()].flat().map((item) => item.id)).toEqual(["saved", "new"]);
});

it("retires stored files and stale callbacks on logout, including a later login to the same account", async () => {
  await show("a");
  await act(async () => current[1]([file("private")]));
  const retired = current[1];
  clearComposerDrafts();
  await reopen("a");
  await act(async () => retired([file("late")]));
  expect(current[0]).toEqual([]);
  expect([...disk.items.values()].flat()).toEqual([]);
});

it("keeps the live file picker usable when durable local storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  try {
    await show("a");
    await act(async () => current[1]([file("memory")]));
    expect(current[0].map((item) => item.id)).toEqual(["memory"]);
    expect(disk.items.size).toBe(0);
  } finally {
    vi.restoreAllMocks();
  }
});

it("flushes a pick immediately before teardown and freezes late edits until the native host resumes", async () => {
  await show("a");
  let finish!: () => void;
  disk.write.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let flushing!: Promise<void>;
  await act(async () => {
    current[1]([file("picked")]);
    flushing = window.orkbotFlushComposerDrafts!();
  });
  await act(async () => current[1]([file("late")]));
  expect(current[0].map((item) => item.id)).toEqual(["picked"]);
  await act(async () => {
    finish();
    await flushing;
  });
  expect(disk.write).toHaveBeenLastCalledWith(expect.any(String), [
    expect.objectContaining({ id: "picked" }),
  ]);
  window.orkbotResumeComposerDrafts!();
  disk.write.mockResolvedValue(undefined);
  await act(async () => current[1]([file("replacement")]));
  expect(current[0].map((item) => item.id)).toEqual(["replacement"]);
});

it("unfreezes the original editor after a failed flush and never persists after logout retires it", async () => {
  await show("a");
  await act(async () => current[1]([file("picked")]));
  disk.write.mockRejectedValueOnce(new Error("quota"));
  await expect(window.orkbotFlushComposerDrafts!()).rejects.toThrow("quota");
  await act(async () => current[1]([file("retry")]));
  expect(current[0].map((item) => item.id)).toEqual(["retry"]);
  clearComposerDrafts();
  disk.write.mockClear();
  await window.orkbotFlushComposerDrafts!();
  expect(disk.write).not.toHaveBeenCalled();
});

it("does not let a timed-out flush's delayed rejection unfreeze a replacement flush", async () => {
  await show("a");
  await act(async () => current[1]([file("picked")]));
  const pending: Array<{ resolve(): void; reject(error: Error): void }> = [];
  disk.write.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const old = window.orkbotFlushComposerDrafts!();
  const rejected = expect(old).rejects.toThrow("old failure");
  await act(async () => {
    await Promise.resolve();
  });
  window.orkbotResumeComposerDrafts!();
  const next = window.orkbotFlushComposerDrafts!();
  await act(async () => {
    await Promise.resolve();
  });
  pending[0]!.reject(new Error("old failure"));
  await rejected;
  await act(async () => current[1]([file("late")]));
  expect(current[0].map((item) => item.id)).toEqual(["picked"]);
  pending[1]!.resolve();
  await next;
  window.orkbotResumeComposerDrafts!();
});
