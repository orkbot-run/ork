// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PendingAttachment } from "../pages/shell/chat-shared";
import { captureComposerDraftSource, isComposerDraftSourceCurrent } from "./composer-draft";
import { registerComposerDraftFlush } from "./composer-draft-flush";
import {
  pinPendingAttachmentDrafts,
  readPendingAttachmentDrafts,
  writePendingAttachmentDrafts,
} from "./pending-attachment-drafts";

/** The native host flushes and freezes exact live editors before destroying their webview. */
export function usePendingAttachmentDrafts(
  spaceId?: string | null,
  userId?: string | null,
): [PendingAttachment[], Dispatch<SetStateAction<PendingAttachment[]>>] {
  const owner = useMemo(() => {
    const source = captureComposerDraftSource("attachments");
    return {
      source,
      scope:
        source.namespace && spaceId && userId
          ? JSON.stringify([source.namespace, spaceId, userId])
          : null,
      items: [] as PendingAttachment[],
      frozen: false,
      loading: Promise.resolve(),
    };
  }, [spaceId, userId]);
  const [state, setState] = useState(() => ({ owner, items: owner.items }));
  const persist = useCallback(async () => {
    await owner.loading;
    if (owner.scope && isComposerDraftSourceCurrent(owner.source))
      await writePendingAttachmentDrafts(owner.scope, owner.items);
  }, [owner]);
  const update = useCallback<Dispatch<SetStateAction<PendingAttachment[]>>>(
    (change) => {
      if (owner.frozen || (owner.source.namespace && !isComposerDraftSourceCurrent(owner.source)))
        return;
      owner.items = typeof change === "function" ? change(owner.items) : change;
      setState({ owner, items: owner.items });
      // Enqueue from the input event, before a native switch can retire this document.
      void persist().catch(() => undefined);
    },
    [owner, persist],
  );
  useEffect(() => {
    let active = true;
    const releasePin = owner.scope ? pinPendingAttachmentDrafts(owner.scope) : () => undefined;
    owner.loading = (owner.scope ? readPendingAttachmentDrafts(owner.scope) : Promise.resolve([]))
      .catch(() => [])
      .then((saved) => {
        if (!active || !isComposerDraftSourceCurrent(owner.source)) return;
        const picked = new Set(owner.items.map((item) => item.id));
        const restored = saved
          .filter((item) => !picked.has(item.id))
          .map((item) => ({
            ...item,
            previewUrl: item.file.type.startsWith("image/")
              ? URL.createObjectURL(item.file)
              : undefined,
          }));
        owner.items = [...restored, ...owner.items];
        setState({ owner, items: owner.items });
      });
    const editor = {
      flush: async () => {
        owner.frozen = true;
        await persist();
      },
      resume: () => {
        owner.frozen = false;
      },
    };
    const unregister = registerComposerDraftFlush(editor);
    return () => {
      active = false;
      releasePin();
      unregister();
    };
  }, [owner, persist]);
  return [state.owner === owner ? state.items : [], update];
}
