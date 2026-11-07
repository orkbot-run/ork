// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache behavior is preserved; first-bot scope fencing is an Ork addition.

import type { Href } from "expo-router";
import {
  captureApiRequestContext,
  currentApiBase,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
} from "./api";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { addToSearchInbox, searchInboxSession } from "./search-inbox";
import { currentSessionGeneration } from "./session";

/**
 * Creates a bot from the inbox's Create menu, adds it to the search roster, and opens its chat.
 * Throws when the bot could not be created.
 */
export async function createInboxBot({
  refreshBots,
  openChat,
}: {
  refreshBots: () => Promise<unknown>;
  openChat: (href: Href) => void;
}) {
  const generation = currentSessionGeneration();
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  const selection = spaceSelectionSeq();
  const current = () =>
    generation === currentSessionGeneration() &&
    apiBase === currentApiBase() &&
    spaceId === selectedSpaceId() &&
    selection === spaceSelectionSeq();
  const askedIn = searchInboxSession();
  try {
    const requestContext = await captureApiRequestContext(spaceId);
    if (!current()) return;
    const options = { requestContext, skipSpaceAuthRecovery: true };
    const [existing, me] = await Promise.all([
      rpc("bots/list", undefined, options),
      rpc("me", undefined, options),
    ]);
    if (!current()) return;
    const isFirstBot = existing.length === 0;
    if (isFirstBot && me.needsModel) {
      openChat("/(settings)/models");
      return;
    }
    const bot = await rpc(
      "bots/create",
      { name: "New Bot", notifyOnFinish: true, computerMode: "team" },
      options,
    );
    if (!current()) return;
    void refreshBots().catch(() => undefined);
    allowFocusPrompt(bot.id);
    addToSearchInbox({ kind: "bot", bot }, askedIn);
    openChat({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
    void (async () => {
      if (!current()) return;
      const started = await rpc("onboarding/start", { botId: bot.id }, options)
        .then(() => true)
        .catch(() => false);
      if (!started || !current()) return;
      scheduleFocusPrompt(bot.id, isFirstBot);
    })();
  } catch (error) {
    if (current()) throw error;
  }
}
