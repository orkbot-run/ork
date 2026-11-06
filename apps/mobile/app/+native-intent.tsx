// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited native routing is preserved; server connection intake is an Ork addition.

import { receiveIncomingShare } from "../lib/incoming-share";
import { receiveServerConnect } from "../lib/server-connect";
import { closeSettingsSheet, isSettingsLink, linkScreen } from "../lib/settings-sheet";

/** A link to a screen outside settings closes the settings sheet first, so the screen opens on
 * the root stack instead of over the sheet. Settings links open inside the sheet. Something
 * shared from another app (expo-sharing opens `orkbot://expo-sharing`) opens the share target screen. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (receiveServerConnect(path)) {
    closeSettingsSheet();
    // The root account gate owns confirmation and authentication before mounting navigation.
    return "/";
  }
  const isShare = linkScreen(path) === "expo-sharing";
  receiveIncomingShare(isShare, initial);
  if (!isSettingsLink(path)) closeSettingsSheet();
  return isShare ? "/share" : path;
}
