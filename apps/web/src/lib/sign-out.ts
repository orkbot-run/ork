// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved. Native logout and device pairing are Ork additions.

import { t } from "@lingui/core/macro";
import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { endCallBeforeSignOut, forgetSignedInUser, sessionChangedUnderPage } from "./call-session";
import { clearComposerDrafts } from "./composer-draft";
import { desktopBridge } from "./desktop";
import { clearSpaceSelection } from "./rpc";

/** Kept across the reload after a failed sign-out, so the fresh page can say it failed. */
export const LOG_OUT_FAILED_KEY = "orkbot.logOutFailed";
/** The reload after a failed sign-out found the user still signed in. */
let logOutFailed = false;

/**
 * Signs out, then loads a fresh page whether or not it worked, so no call, microphone, pending
 * answer or queued request from this session survives in the page.
 */
export async function signOut(destination: string): Promise<void> {
  const desktop = desktopBridge();
  if (desktop?.accounts) {
    if (sessionChangedUnderPage()) {
      window.location.reload();
      return;
    }
    // Native logout durably queues revocation and clears HttpOnly cookies without network access.
    // Stop local audio now; a pending server hang-up cannot delay leaving the old session.
    void endCallBeforeSignOut().catch(() => undefined);
    try {
      await desktop.accounts.logout();
    } catch {
      reloadAfterFailedSignOut();
      return;
    }
    if (sessionChangedUnderPage()) {
      window.location.reload();
      return;
    }
    forgetSignedInUser();
    clearSpaceSelection();
    clearComposerDrafts();
    await Promise.resolve()
      .then(() => desktop.server?.change())
      .catch(() => undefined);
    window.location.assign(destination);
    return;
  }
  // Browser fixtures and older hosts still use the authenticated server logout endpoint.
  await endCallBeforeSignOut();
  if (sessionChangedUnderPage()) {
    window.location.reload();
    return;
  }
  await Promise.resolve()
    .then(() => desktop?.pairing?.clear())
    .catch(() => undefined);
  if (sessionChangedUnderPage()) {
    window.location.reload();
    return;
  }
  const result = await authClient.signOut().catch(() => null);
  if (result && !result.error) {
    forgetSignedInUser();
    clearSpaceSelection();
    clearComposerDrafts();
    window.location.assign(destination);
  } else {
    reloadAfterFailedSignOut();
  }
}

function reloadAfterFailedSignOut(): void {
  try {
    sessionStorage.setItem(LOG_OUT_FAILED_KEY, "1");
  } catch {
    // No storage: the page still reloads, without the failure message.
  }
  window.location.reload();
}

/**
 * Called once the page knows its session. A failed sign-out is reported only when the fresh page
 * is still signed in; either way the marker is read once.
 */
export function syncLogOutFailure(signedIn: boolean): void {
  try {
    if (sessionStorage.getItem(LOG_OUT_FAILED_KEY) === null) return;
    sessionStorage.removeItem(LOG_OUT_FAILED_KEY);
  } catch {
    return;
  }
  if (!signedIn) clearComposerDrafts();
  logOutFailed = signedIn;
}

export function useSignOut(destination: string, onError: (message: string) => void) {
  const busy = useRef(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!logOutFailed) return;
    logOutFailed = false;
    onError(t`Could not log out. Try again.`);
  }, [onError]);

  async function logOut() {
    if (busy.current) return;
    busy.current = true;
    setSigningOut(true);
    // The page is left either way, so it stays busy until then.
    await signOut(destination);
  }

  return { signingOut, logOut };
}
