import { safeLocalStorage } from "./storage";

/** Set once a session is seen, so a signed-out return to `/` opens sign-in instead of sign-up. */
export const SIGNED_IN_BEFORE_KEY = "orkbot.signed-in-before";

export function hasSignedInBefore(): boolean {
  return safeLocalStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
}

export function rememberSignedIn(): void {
  safeLocalStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
}

/** A deleted account has nothing to sign in to, so the next visit offers sign up again. */
export function forgetSignedIn(): void {
  safeLocalStorage.removeItem(SIGNED_IN_BEFORE_KEY);
}
