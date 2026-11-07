// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Call speaker ownership changes follow LICENSE.md.

import type { Bot, ThreadMessage, ThreadSnapshot } from "@orkbot/contracts";
import { speechFromBlocks } from "@orkbot/core";
import { toast } from "@orkbot/ui-web";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { speaker } from "../../lib/tts";

const READ_ALOUD_TOAST = "read-aloud-error";

/** Chat read-aloud has no caption to carry a failure, so it surfaces as a toast. */
function readAloud(text: string, opts: { botId: string; messageId: string }) {
  void speaker.speak(text, opts).then((error) => {
    if (error) toast.error(error, { id: READ_ALOUD_TOAST });
  });
}

/** Reads bot replies aloud: on request, and automatically for bots that speak their replies. */
export function useReadAloud({
  active,
  snapshot,
  callBotId,
  activeBotId,
}: {
  active: Bot | undefined;
  snapshot: ThreadSnapshot | null;
  callBotId: string | undefined;
  activeBotId: RefObject<string | undefined>;
}) {
  const canReadAloud = useSyncExternalStore(
    speaker.subscribeOwnership,
    speaker.canSpeak,
    speaker.canSpeak,
  );
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  useEffect(() => {
    const unsubSpeech = speaker.subscribe((state) => {
      setSpeakingMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    return () => {
      unsubSpeech();
    };
  }, []);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (callBotId || !speaker.canSpeak() || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    readAloud(text, { botId: active.id, messageId: lastBot.id });
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    callBotId,
  ]);

  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      speaker.stop();
      return;
    }
    if (!speaker.canSpeak()) return;
    const text = speechFromBlocks(message.blocks);
    const id = message.botId ?? activeBotId.current;
    if (text && id) readAloud(text, { botId: id, messageId: message.id });
  }, []);

  return { speakingMessageId, speakMessage, canReadAloud };
}
