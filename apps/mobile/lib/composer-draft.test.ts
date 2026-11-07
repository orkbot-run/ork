// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Verified migration and scope fences follow LICENSE.md.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComposerDraftScope } from "./composer-draft";
import { readComposerDraft, writeComposerDraft } from "./composer-draft";
import {
  clearComposerDraftAttachments,
  DRAFT_ATTACHMENT_MAX_BYTES,
  DRAFT_ATTACHMENT_MAX_CHATS,
  DRAFT_ATTACHMENT_RETENTION_MS,
  pinComposerDraft,
  readComposerDraftAttachments,
  writeComposerDraftAttachments,
} from "./composer-draft-attachments";

vi.mock("./api", () => ({ currentApiBase: () => "https://api.example.test" }));

const login = vi.hoisted(() => ({ namespace: "login-a" as string | undefined }));
vi.mock("./artifact-cache-session", () => ({ currentArtifactCacheSession: () => login.namespace }));

const files = vi.hoisted(() => new Map<string, string>());
/** Copy steps throw while `copy` is true; file creation is silent while `create` is, as on iOS. */
const failing = vi.hoisted(() => ({
  copy: false,
  create: false,
  partial: false,
  partialMove: false,
  marker: false,
  silentDelete: false,
  corruptCopyBytes: undefined as string | undefined,
  raw: new Map<string, string>(),
  delete: false,
  sizes: new Map<string, number>(),
}));
vi.mock("expo-file-system", () => {
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get name() {
      return this.uri.split("/").pop()!;
    }
    get exists() {
      return [...files.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    create() {}
    delete() {
      if (failing.delete) throw new Error("Delete failed");
      for (const path of [...files.keys()]) if (path.startsWith(`${this.uri}/`)) files.delete(path);
    }
    list() {
      const names = new Set(
        [...files.keys()]
          .filter((path) => path.startsWith(`${this.uri}/`))
          .map((path) => path.slice(this.uri.length + 1).split("/")[0]!),
      );
      return [...names].map((name) =>
        files.has(`${this.uri}/${name}`) ? new File(this, name) : new Directory(this, name),
      );
    }
    // Like the device, a directory lands inside an existing destination.
    copySync(destination: Directory) {
      if (failing.copy) throw new Error("Copy failed");
      const target = destination.exists
        ? `${destination.uri}/${this.uri.split("/").pop()}`
        : destination.uri;
      for (const path of [...files.keys()])
        if (path.startsWith(`${this.uri}/`))
          files.set(target + path.slice(this.uri.length), files.get(path)!);
    }
  }
  class File extends Directory {
    override get exists() {
      return files.has(this.uri);
    }
    get size() {
      return (
        failing.sizes.get(this.uri) ?? new TextEncoder().encode(files.get(this.uri) ?? "").length
      );
    }
    override copySync(destination: File) {
      if (failing.copy) throw new Error("Copy failed");
      files.set(destination.uri, failing.partial ? "partial" : files.get(this.uri)!);
      if (failing.corruptCopyBytes) failing.raw.set(destination.uri, failing.corruptCopyBytes);
      else if (failing.raw.has(this.uri))
        failing.raw.set(destination.uri, failing.raw.get(this.uri)!);
      else failing.raw.delete(destination.uri);
    }
    base64Sync() {
      return failing.raw.get(this.uri) ?? Buffer.from(files.get(this.uri) ?? "").toString("base64");
    }
    textSync() {
      return files.get(this.uri);
    }
    override create(options?: { overwrite?: boolean }) {
      if (this.exists && !options?.overwrite) throw new Error("File exists");
      if (failing.create || (failing.marker && this.uri.endsWith("legacy-done"))) return;
      files.set(this.uri, "");
    }
    override delete() {
      if (failing.delete) throw new Error("Delete failed");
      if (failing.silentDelete) return;
      files.delete(this.uri);
      failing.raw.delete(this.uri);
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    moveSync(destination: File, options?: { overwrite?: boolean }) {
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      files.set(destination.uri, failing.partialMove ? "partial" : files.get(this.uri)!);
      if (failing.raw.has(this.uri)) failing.raw.set(destination.uri, failing.raw.get(this.uri)!);
      else failing.raw.delete(destination.uri);
      failing.raw.delete(this.uri);
      files.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  return { Directory, File, Paths: { cache: "cache", document: "document" } };
});

const scope: ComposerDraftScope = {
  apiBase: "https://api.example.test",
  userId: "user-a",
  threadKey: "bot:bot-1",
  namespace: "login-a",
};
function draftPath(root: string) {
  return `${root}/composer-drafts-v1/${encodeURIComponent(scope.apiBase)}/user-${encodeURIComponent(scope.userId)}/${encodeURIComponent(scope.threadKey)}.json`;
}
function legacyDraft(body: string) {
  files.set(draftPath("cache"), JSON.stringify({ version: 1, text: body, bindings: [] }));
}

beforeEach(() => {
  files.clear();
  login.namespace = "login-a";
  failing.partial = false;
  failing.partialMove = false;
  failing.marker = false;
  failing.delete = false;
  failing.silentDelete = false;
  failing.corruptCopyBytes = undefined;
  failing.raw.clear();
  failing.sizes.clear();
  failing.copy = false;
  failing.create = false;
});

it("keeps drafts in documents, not the cache", () => {
  expect(writeComposerDraft(scope, "Draft text", [])).toBe(true);
  expect(files.has(draftPath("document"))).toBe(true);
  expect(files.has(draftPath("cache"))).toBe(false);
  expect(readComposerDraft(scope)).toEqual({ text: "Draft text", bindings: [] });
});

it("moves a draft left in the cache into documents before reading it", () => {
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Legacy draft");
  expect(files.has(draftPath("document"))).toBe(true);
  expect(files.has(draftPath("cache"))).toBe(false);
});

it("does not copy a migrated cache draft over a newer saved one", () => {
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Legacy draft");
  expect(writeComposerDraft(scope, "Newer draft", [])).toBe(true);
  legacyDraft("Legacy draft");
  expect(readComposerDraft(scope).text).toBe("Newer draft");
});

it("does not let a cache draft reappear over drafts from a clean first launch", () => {
  expect(writeComposerDraft(scope, "First draft", [])).toBe(true);
  // A downgrade wrote to the cache again; its copy must not replace the newer draft.
  legacyDraft("Downgrade draft");
  expect(readComposerDraft(scope).text).toBe("First draft");
  expect(files.has(draftPath("document"))).toBe(true);
});

it("reads the draft from the cache while the copy to documents fails", () => {
  legacyDraft("Unsent draft");
  failing.copy = true;
  expect(readComposerDraft(scope).text).toBe("Unsent draft");
  failing.copy = false;
  // The composer's automatic save of what it read cannot erase the draft.
  expect(writeComposerDraft(scope, "Unsent draft", [])).toBe(true);
  expect(readComposerDraft(scope).text).toBe("Unsent draft");
});
it("does not save drafts when the clean-launch marker cannot be verified", () => {
  failing.create = true;
  expect(writeComposerDraft(scope, "First draft", [])).toBe(false);
  expect(files.has(draftPath("document"))).toBe(false);
  expect(readComposerDraft(scope).text).toBe("");
});

it("keeps the complete source when native copy silently truncates and retries it", () => {
  legacyDraft("Complete legacy draft");
  failing.partial = true;
  expect(readComposerDraft(scope).text).toBe("Complete legacy draft");
  expect(files.has("document/composer-drafts-legacy-done")).toBe(false);
  expect(files.has(draftPath("cache"))).toBe(true);
  failing.partial = false;
  expect(readComposerDraft(scope).text).toBe("Complete legacy draft");
  expect(files.has(draftPath("cache"))).toBe(false);
});

it("retries a marker failure without deleting newer documents", () => {
  legacyDraft("Legacy draft");
  files.set(
    draftPath("document"),
    JSON.stringify({ version: 1, text: "Newer draft", bindings: [] }),
  );
  failing.marker = true;
  expect(readComposerDraft(scope).text).toBe("Newer draft");
  expect(files.has(draftPath("cache"))).toBe(true);
  expect(files.has("document/composer-drafts-legacy-done")).toBe(false);
  failing.marker = false;
  expect(readComposerDraft(scope).text).toBe("Newer draft");
  expect(files.get(`${draftPath("document")}.legacy`)).toBe(
    files.get(draftPath("cache")) ??
      JSON.stringify({ version: 1, text: "Legacy draft", bindings: [] }),
  );
  expect(files.has(draftPath("cache"))).toBe(false);
});

it("refuses a late write after logout followed by another login, including the same user", () => {
  expect(writeComposerDraft(scope, "Existing text", [])).toBe(true);
  login.namespace = "login-b";
  expect(writeComposerDraft(scope, "Late stale text", [])).toBe(false);
  expect(readComposerDraft(scope).text).toBe("");
  expect(readComposerDraft({ ...scope, namespace: "login-b" }).text).toBe("Existing text");
  expect(readComposerDraft({ ...scope, namespace: "login-b", userId: "user-b" }).text).toBe("");
});

afterEach(() => vi.restoreAllMocks());
const attachment = (id = "file-a") => ({
  id,
  name: "photo.png",
  mimeType: "image/png" as const,
  contentBase64: "aGk=",
  previewUri: "file:///ephemeral-picker.png",
});
const attachmentPath = (owner = scope) =>
  `document/composer-attachments-v1/${encodeURIComponent(owner.namespace)}/${encodeURIComponent(owner.apiBase)}/${encodeURIComponent(owner.userId)}/${encodeURIComponent(owner.threadKey)}.json`;

it("stores attachment bytes separately from text and rebuilds previews after a module restart", async () => {
  expect(writeComposerDraft(scope, "Text before", [])).toBe(true);
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(true);
  expect(writeComposerDraft(scope, "Text after", [])).toBe(true);
  expect(files.get(attachmentPath())).not.toContain("ephemeral-picker");
  vi.resetModules();
  const restored = await import("./composer-draft-attachments");
  expect(restored.readComposerDraftAttachments(scope)).toEqual([
    { ...attachment(), previewUri: "data:image/png;base64,aGk=" },
  ]);
  expect(readComposerDraft(scope).text).toBe("Text after");
  expect(restored.writeComposerDraftAttachments(scope, [])).toBe(true);
  expect(files.has(attachmentPath())).toBe(false);
});

it("isolates pending bytes after logout even if file deletion fails and the same user signs in", () => {
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(true);
  failing.delete = true;
  clearComposerDraftAttachments();
  expect(files.has(attachmentPath())).toBe(true);
  login.namespace = "login-new";
  expect(readComposerDraftAttachments({ ...scope, namespace: "login-new" })).toEqual([]);
  expect(
    readComposerDraftAttachments({ ...scope, namespace: "login-new", userId: "user-b" }),
  ).toEqual([]);
  expect(writeComposerDraftAttachments(scope, [attachment("late")])).toBe(false);
  expect(files.get(attachmentPath())).toContain('"id":"file-a"');
});

it("rejects admission when the chat count is full without evicting another unsent draft", () => {
  for (let index = 0; index < DRAFT_ATTACHMENT_MAX_CHATS; index++)
    expect(
      writeComposerDraftAttachments({ ...scope, threadKey: `bot:${index}` }, [attachment()]),
    ).toBe(true);
  expect(
    writeComposerDraftAttachments({ ...scope, threadKey: "bot:overflow" }, [attachment()]),
  ).toBe(false);
  expect(readComposerDraftAttachments({ ...scope, threadKey: "bot:0" })).toHaveLength(1);
});

it("rejects a full byte budget before writing a replacement", () => {
  const other = { ...scope, threadKey: "bot:other" };
  writeComposerDraftAttachments(other, [attachment()]);
  failing.sizes.set(attachmentPath(other), DRAFT_ATTACHMENT_MAX_BYTES);
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(false);
  expect(files.has(attachmentPath())).toBe(false);
  expect(readComposerDraftAttachments(other)).toHaveLength(1);
});

it("reclaims only expired unpinned sources and never an active or in-flight editor", () => {
  const active = { ...scope, threadKey: "bot:active" };
  const idle = { ...scope, threadKey: "bot:idle" };
  writeComposerDraftAttachments(active, [attachment()]);
  writeComposerDraftAttachments(idle, [attachment()]);
  const release = pinComposerDraft(active);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + DRAFT_ATTACHMENT_RETENTION_MS + 1);
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(true);
  expect(files.has(attachmentPath(active))).toBe(true);
  expect(files.has(attachmentPath(idle))).toBe(false);
  release();
  release();
});

it("keeps the last complete attachment payload when staging silently truncates", () => {
  writeComposerDraftAttachments(scope, [attachment("first")]);
  const saved = files.get(attachmentPath());
  const target = `${attachmentPath()}.tmp`;
  const previous = files.set.bind(files);
  vi.spyOn(files, "set").mockImplementation((path, value) =>
    previous(path, path === target ? "partial" : value),
  );
  expect(writeComposerDraftAttachments(scope, [attachment("second")])).toBe(false);
  expect(files.get(attachmentPath())).toBe(saved);
  expect(readComposerDraftAttachments(scope).map((item) => item.id)).toEqual(["first"]);
});

it("persists an empty record when native deletion silently leaves a source behind", () => {
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(true);
  failing.silentDelete = true;
  expect(writeComposerDraftAttachments(scope, [])).toBe(true);
  expect(files.has(attachmentPath())).toBe(true);
  expect(readComposerDraftAttachments(scope)).toEqual([]);
  failing.silentDelete = false;
  expect(writeComposerDraftAttachments(scope, [])).toBe(true);
  expect(readComposerDraftAttachments(scope)).toEqual([]);
});

it("fails closed and preserves the last complete source when retirement cannot be verified", () => {
  expect(writeComposerDraftAttachments(scope, [attachment()])).toBe(true);
  const original = files.get(attachmentPath());
  failing.silentDelete = true;
  const previous = files.set.bind(files);
  vi.spyOn(files, "set").mockImplementation((path, value) =>
    previous(path, path === `${attachmentPath()}.tmp` ? "partial" : value),
  );
  expect(writeComposerDraftAttachments(scope, [])).toBe(false);
  expect(files.get(attachmentPath())).toBe(original);
  expect(readComposerDraftAttachments(scope)).toHaveLength(1);
});

it("verifies exact migrated bytes when distinct invalid UTF-8 decodes to identical text", () => {
  const raw = (byte: number) =>
    Buffer.concat([
      Buffer.from('{"version":1,"text":"Draft '),
      Buffer.from([byte]),
      Buffer.from('","bindings":[]}'),
    ]);
  const source = raw(255);
  const corrupted = raw(254);
  expect(source.toString("utf8")).toBe(corrupted.toString("utf8"));
  expect(source.equals(corrupted)).toBe(false);
  files.set(draftPath("cache"), source.toString("utf8"));
  failing.raw.set(draftPath("cache"), source.toString("base64"));
  failing.corruptCopyBytes = corrupted.toString("base64");
  expect(readComposerDraft(scope).text).toBe("Draft �");
  expect(files.has("document/composer-drafts-legacy-done")).toBe(false);
  expect(files.has(draftPath("cache"))).toBe(true);
  failing.corruptCopyBytes = undefined;
  expect(readComposerDraft(scope).text).toBe("Draft �");
  expect(files.has(draftPath("cache"))).toBe(false);
  expect(failing.raw.get(draftPath("document"))).toBe(source.toString("base64"));
});

it("recovers the complete prior attachment record after a silent partial native replacement", () => {
  expect(writeComposerDraftAttachments(scope, [attachment("first")])).toBe(true);
  failing.partialMove = true;
  expect(writeComposerDraftAttachments(scope, [attachment("second")])).toBe(false);
  expect(readComposerDraftAttachments(scope).map((item) => item.id)).toEqual(["first"]);
  failing.partialMove = false;
  expect(writeComposerDraftAttachments(scope, [attachment("second")])).toBe(true);
  expect(readComposerDraftAttachments(scope).map((item) => item.id)).toEqual(["second"]);
});
