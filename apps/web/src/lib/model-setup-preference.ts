// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

type WorkspaceIdentity = { userId: string; spaceId: string };

const sessionDeferrals = new Set<string>();

function key({ userId, spaceId }: WorkspaceIdentity) {
  return `orkbot:model-setup-deferred:${JSON.stringify([userId, spaceId])}`;
}

/** Defer this screen for this user and workspace on the current server origin. */
export function deferModelSetup(identity: WorkspaceIdentity) {
  const preference = key(identity);
  sessionDeferrals.add(preference);
  try {
    window.localStorage.setItem(preference, "1");
  } catch {
    // The running app can still honor the choice if browser storage is unavailable.
  }
}

export function modelSetupDeferred(identity: WorkspaceIdentity) {
  const preference = key(identity);
  if (sessionDeferrals.has(preference)) return true;
  try {
    return window.localStorage.getItem(preference) === "1";
  } catch {
    return false;
  }
}
