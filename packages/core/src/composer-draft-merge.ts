// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ComposerMentionBinding } from "./composer-mention-bindings.js";
import { validateComposerMentionBindings } from "./composer-mention-bindings.js";

export type ComposerDraftContent = { text: string; bindings: readonly ComposerMentionBinding[] };

/** Recover older words before newer edits, retaining the identity of each mention occurrence. */
export function mergeComposerDraftContent(
  recovered: ComposerDraftContent,
  current: ComposerDraftContent,
): { text: string; bindings: ComposerMentionBinding[] } {
  if (!recovered.text)
    return {
      text: current.text,
      bindings: validateComposerMentionBindings(current.text, current.bindings),
    };
  if (!current.text)
    return {
      text: recovered.text,
      bindings: validateComposerMentionBindings(recovered.text, recovered.bindings),
    };
  const separator = "\n";
  const offset = recovered.text.length + separator.length;
  const text = recovered.text + separator + current.text;
  return {
    text,
    bindings: validateComposerMentionBindings(text, [
      ...validateComposerMentionBindings(recovered.text, recovered.bindings),
      ...validateComposerMentionBindings(current.text, current.bindings).map((binding) => ({
        ...binding,
        start: binding.start + offset,
        end: binding.end + offset,
      })),
    ]),
  };
}
