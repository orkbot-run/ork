// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

declare global {
  interface Window {
    orkbotFlushComposerDrafts?: () => Promise<void>;
    orkbotResumeComposerDrafts?: () => void;
  }
}
type Editor = { flush(): Promise<void>; resume(): void };
const editors = new Set<Editor>();
let revision = 0;
export function registerComposerDraftFlush(editor: Editor): () => void {
  editors.add(editor);
  return () => {
    editors.delete(editor);
  };
}
if (typeof window !== "undefined") {
  window.orkbotResumeComposerDrafts = () => {
    revision += 1;
    for (const editor of editors) editor.resume();
  };
  window.orkbotFlushComposerDrafts = async () => {
    const attempt = ++revision;
    try {
      await Promise.all([...editors].map((editor) => editor.flush()));
    } catch (error) {
      if (revision === attempt) window.orkbotResumeComposerDrafts?.();
      throw error;
    }
  };
}
