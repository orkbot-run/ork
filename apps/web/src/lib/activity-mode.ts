import { safeLocalStorage } from "./storage";

/** Persisted recency mode for the sidebar activity sections. Default off. */
export const ACTIVITY_MODE_KEY = "orkbot.activity-mode";

export function readActivityMode(): boolean {
  try {
    return safeLocalStorage.getItem(ACTIVITY_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeActivityMode(on: boolean): void {
  try {
    if (on) safeLocalStorage.setItem(ACTIVITY_MODE_KEY, "1");
    else safeLocalStorage.removeItem(ACTIVITY_MODE_KEY);
  } catch {
    // Private mode / blocked storage — keep in-memory only.
  }
}
