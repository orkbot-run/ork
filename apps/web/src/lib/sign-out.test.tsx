// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved. Native logout and pairing tests are Ork additions.

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CallSessionModule from "./call-session";
import { SIGNED_IN_USER_KEY } from "./call-session";
import {
  composerDraftBindingsKey,
  hasUnsentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";
import { COMPOSER_ENTER_TO_SEND_STORAGE_KEY } from "./composer-enter-to-send-pref";
import { selectedSpaceId, selectSpace } from "./rpc";
import { LOG_OUT_FAILED_KEY, signOut, syncLogOutFailure, useSignOut } from "./sign-out";

const nativePairing = vi.hoisted(() => ({
  enabled: false,
  clear: vi.fn<() => Promise<void>>(async () => undefined),
}));
const nativeAccounts = vi.hoisted(() => ({
  enabled: false,
  logout: vi.fn<() => Promise<void>>(async () => undefined),
  change: vi.fn<() => Promise<void>>(async () => undefined),
}));

const { requestSignOut, endCallBeforeSignOut, sessionChangedUnderPage } = vi.hoisted(() => ({
  requestSignOut: vi.fn(),
  endCallBeforeSignOut: vi.fn(async () => undefined),
  sessionChangedUnderPage: vi.fn(() => false),
}));

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./auth", () => ({ authClient: { signOut: requestSignOut } }));
vi.mock("./desktop", () => ({
  desktopBridge: () =>
    nativePairing.enabled || nativeAccounts.enabled
      ? {
          ...(nativePairing.enabled ? { pairing: { clear: nativePairing.clear } } : {}),
          ...(nativeAccounts.enabled
            ? {
                accounts: { logout: nativeAccounts.logout },
                server: { change: nativeAccounts.change },
              }
            : {}),
        }
      : undefined,
}));
vi.mock("./call-session", async (importOriginal) => ({
  ...(await importOriginal<typeof CallSessionModule>()),
  endCallBeforeSignOut,
  sessionChangedUnderPage,
}));

const location = { assign: vi.fn(), reload: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  nativePairing.enabled = false;
  nativeAccounts.enabled = false;
  nativeAccounts.logout.mockResolvedValue(undefined);
  nativeAccounts.change.mockResolvedValue(undefined);
  sessionChangedUnderPage.mockReturnValue(false);
  nativePairing.clear.mockResolvedValue(undefined);
  vi.stubGlobal("location", location);
  requestSignOut.mockReset();
  requestSignOut.mockResolvedValue({ data: { success: true }, error: null });
  localStorage.setItem(SIGNED_IN_USER_KEY, "user-1");
  selectSpace("space-1");
  writeComposerDraft("bot:bot-1", "unsent thought");
  localStorage.setItem(composerDraftBindingsKey("bot:bot-1"), "{}");
  localStorage.setItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY, "false");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

function mountSignOut(destination: string, onError: (message: string) => void = () => undefined) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const controls: { current?: ReturnType<typeof useSignOut> } = {};
  function Harness() {
    controls.current = useSignOut(destination, onError);
    const { signingOut, logOut } = controls.current;
    return <button type="button" disabled={signingOut} onClick={() => void logOut()} />;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  return {
    container,
    logOut: () => controls.current!.logOut(),
    unmount: () => act(() => root.unmount()),
  };
}

describe("signOut", () => {
  it("leaves a native session without waiting for hang-up or a server logout request", async () => {
    nativeAccounts.enabled = true;
    nativePairing.enabled = true;
    endCallBeforeSignOut.mockReturnValueOnce(new Promise<undefined>(() => {}));
    let finish = () => {};
    nativeAccounts.logout.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = signOut("/sign-in");
    await vi.waitFor(() => expect(nativeAccounts.logout).toHaveBeenCalledOnce());
    expect(endCallBeforeSignOut).toHaveBeenCalledOnce();
    expect(requestSignOut).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(requestSignOut).not.toHaveBeenCalled();
    expect(nativePairing.clear).not.toHaveBeenCalled();
    expect(nativeAccounts.change).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(readComposerDraft("bot:bot-1")).toBe("");
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBeNull();
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
  });

  it("finishes native offline logout even when HTTP sign-out would fail", async () => {
    nativeAccounts.enabled = true;
    requestSignOut.mockRejectedValueOnce(new TypeError("offline"));
    await signOut("/sign-in");
    expect(nativeAccounts.logout).toHaveBeenCalledOnce();
    expect(requestSignOut).not.toHaveBeenCalled();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(location.reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
  });

  it("reports failure when native Accounts cannot be forgotten", async () => {
    nativeAccounts.enabled = true;
    nativeAccounts.logout.mockRejectedValueOnce(new Error("secure storage unavailable"));
    await signOut("/sign-in");
    expect(requestSignOut).not.toHaveBeenCalled();
    expect(nativeAccounts.change).not.toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBe("1");
  });

  it("does not end a newer server session after native Accounts cleanup", async () => {
    nativeAccounts.enabled = true;
    sessionChangedUnderPage.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await signOut("/sign-in");
    expect(nativeAccounts.logout).toHaveBeenCalledOnce();
    expect(requestSignOut).not.toHaveBeenCalled();
    expect(nativeAccounts.change).not.toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("leaves for sign-in even if the native picker could not open", async () => {
    nativeAccounts.enabled = true;
    nativeAccounts.change.mockRejectedValueOnce(new Error("window unavailable"));
    await signOut("/sign-in");
    expect(nativeAccounts.logout).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
  });

  it("clears native device access before sending the web sign-out request", async () => {
    nativePairing.enabled = true;
    let finishClear = () => {};
    nativePairing.clear.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishClear = resolve;
      }),
    );
    const signingOut = signOut("/sign-in");
    await vi.waitFor(() => expect(nativePairing.clear).toHaveBeenCalledOnce());
    expect(requestSignOut).not.toHaveBeenCalled();
    finishClear();
    await signingOut;
    expect(nativePairing.clear.mock.invocationCallOrder[0]).toBeLessThan(
      requestSignOut.mock.invocationCallOrder[0] ?? 0,
    );
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
  });

  it("does not sign out another account after native cleanup finishes", async () => {
    nativePairing.enabled = true;
    sessionChangedUnderPage.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await signOut("/sign-in");
    expect(nativePairing.clear).toHaveBeenCalledOnce();
    expect(requestSignOut).not.toHaveBeenCalled();
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"])("still signs out when native cleanup fails (%s)", async (mode) => {
    nativePairing.enabled = true;
    if (mode === "throw")
      nativePairing.clear.mockImplementationOnce(() => {
        throw new Error("Unavailable");
      });
    else nativePairing.clear.mockRejectedValueOnce(new Error("Unavailable"));
    await signOut("/sign-in");
    expect(requestSignOut).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
  });

  it("clears native access even when the web sign-out request fails", async () => {
    nativePairing.enabled = true;
    requestSignOut.mockRejectedValueOnce(new Error("Network"));
    await signOut("/sign-in");
    expect(nativePairing.clear).toHaveBeenCalledOnce();
    expect(location.reload).toHaveBeenCalledOnce();
  });

  it("ends the call first, then leaves for the destination signed out", async () => {
    await signOut("/sign-in");
    expect(endCallBeforeSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      requestSignOut.mock.invocationCallOrder[0] ?? 0,
    );
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(location.reload).not.toHaveBeenCalled();
    // Other tabs reload when the signed-in user is cleared.
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBeNull();
    expect(selectedSpaceId()).toBeNull();
  });

  it("leaves no saved draft for whoever uses this browser next", async () => {
    await signOut("/sign-in");
    expect(readComposerDraft("bot:bot-1")).toBe("");
    expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBeNull();
    expect(hasUnsentComposerDraft()).toBe(false);
    expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("false");
  });

  it.each([
    ["an error result", () => requestSignOut.mockResolvedValue({ error: { status: 500 } })],
    ["a rejected request", () => requestSignOut.mockRejectedValue(new Error("Network"))],
  ])("reloads the page after %s", async (_name, fail) => {
    fail();
    await signOut("/");
    expect(location.reload).toHaveBeenCalledOnce();
    expect(location.assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(SIGNED_IN_USER_KEY)).toBe("user-1");
    expect(readComposerDraft("bot:bot-1")).toBe("unsent thought");
    expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBe("{}");
  });

  it("says the sign-out failed when the reloaded page is still signed in", async () => {
    requestSignOut.mockResolvedValue({ error: { status: 500 } });
    await signOut("/sign-in");
    expect(location.reload).toHaveBeenCalledOnce();
    // The reloaded page resolves its session as still signed in.
    syncLogOutFailure(true);
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
    const onError = vi.fn();
    const view = mountSignOut("/sign-in", onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not log out. Try again.");
    view.unmount();
    // Reported once: a later sign-out control starts clean.
    const later = vi.fn();
    mountSignOut("/sign-in", later).unmount();
    expect(later).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "clears saved drafts after a failed sign-out only when signed out (signedIn=%s)",
    (signedIn) => {
      sessionStorage.setItem(LOG_OUT_FAILED_KEY, "1");
      syncLogOutFailure(signedIn);
      expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
      expect(readComposerDraft("bot:bot-1")).toBe(signedIn ? "unsent thought" : "");
      expect(localStorage.getItem(composerDraftBindingsKey("bot:bot-1"))).toBe(
        signedIn ? "{}" : null,
      );
      expect(hasUnsentComposerDraft()).toBe(signedIn);
      expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("false");
      // Consume any failure message before the next test.
      mountSignOut("/sign-in").unmount();
    },
  );

  it("says nothing when the reloaded page is signed out", async () => {
    requestSignOut.mockRejectedValue(new Error("Network"));
    await signOut("/sign-in");
    syncLogOutFailure(false);
    expect(sessionStorage.getItem(LOG_OUT_FAILED_KEY)).toBeNull();
    // Signing in again later in this tab must not show a stale failure.
    syncLogOutFailure(true);
    const onError = vi.fn();
    mountSignOut("/sign-in", onError).unmount();
    expect(onError).not.toHaveBeenCalled();
  });
});

it("blocks re-entry and stays busy until the page is left", async () => {
  const view = mountSignOut("/sign-in");
  try {
    await act(async () => {
      await Promise.all([view.logOut(), view.logOut()]);
    });
    expect(requestSignOut).toHaveBeenCalledOnce();
    expect(location.assign).toHaveBeenCalledWith("/sign-in");
    expect(view.container.querySelector("button")?.disabled).toBe(true);
  } finally {
    view.unmount();
  }
});
