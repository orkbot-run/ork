// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors to share the inherited Apache-2.0 inspection script.
// New Ork changes follow LICENSE.md.

import { APP_DOCUMENT_STATE_SCRIPT } from "./app-document-script.js";
import { t, withDetail } from "./i18n.js";

export { APP_DOCUMENT_STATE_SCRIPT } from "./app-document-script.js";

/** `pending`: the page is still loading when the wait ends, for instance on a slow server. */
export type AppDocumentState = "ready" | "failed" | "pending";

type DocumentContents = Pick<
  Electron.WebContents,
  "executeJavaScript" | "isCrashed" | "isDestroyed"
>;

const TIMED_OUT = Symbol("timed-out");

/** A hung renderer must not hold the wait past its deadline; a late answer is ignored. */
function withRemainingDeadline<T>(
  call: () => Promise<T>,
  remainingMs: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
  });
  return Promise.race([call(), timeout]).finally(() => clearTimeout(timer));
}

export async function waitForMountedAppDocument(
  contents: DocumentContents,
  timeoutMs = 20_000,
): Promise<AppDocumentState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (contents.isDestroyed()) {
      throw withDetail(
        new Error("The window closed before the app loaded."),
        t("The window closed before the app loaded."),
      );
    }
    if (contents.isCrashed()) {
      throw withDetail(
        new Error("Renderer stopped after load."),
        t("Renderer stopped after load."),
      );
    }
    let state: AppDocumentState;
    try {
      const answer = await withRemainingDeadline(
        () => contents.executeJavaScript(APP_DOCUMENT_STATE_SCRIPT),
        deadline - Date.now(),
      );
      state = answer === TIMED_OUT ? "pending" : (answer as AppDocumentState);
    } catch (error) {
      // A reload or redirect during startup disposes the frame being asked; ask the next document.
      if (contents.isDestroyed()) throw error;
      state = "pending";
    }
    if (state !== "pending") return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  return "pending";
}
