// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
// Inherited Apache-2.0 material; new Ork changes are PolyForm-Noncommercial-1.0.0.

import { openAuthSessionAsync, WebBrowserResultType } from "expo-web-browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authHeaders, clearSpace, currentApiBase, fetchMobileJson } from "./api";
import {
  currentSessionGeneration,
  replaceSessionTokenIfCurrent,
  rotateSessionTokenIfCurrent,
} from "./session";
import { continueWithSso } from "./sso";

vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
  WebBrowserResultType: { CANCEL: "cancel", DISMISS: "dismiss" },
}));
vi.mock("./api", () => ({
  authHeaders: vi.fn(async () => ({ authorization: "Bearer old-session" })),
  clearSpace: vi.fn(async () => true),
  currentApiBase: vi.fn(() => "https://orkbot.example.test"),
  fetchMobileJson: vi.fn(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: vi.fn(() => 1),
  replaceSessionTokenIfCurrent: vi.fn(async () => true),
  rotateSessionTokenIfCurrent: vi.fn(async () => true),
  tokenFromAuthResponse: (response: Response) =>
    response.headers.get("set-cookie")?.match(/session_token=([^;]+)/)?.[1] ?? "",
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(replaceSessionTokenIfCurrent).mockReset().mockResolvedValue(true);
  vi.mocked(rotateSessionTokenIfCurrent).mockReset().mockResolvedValue(true);
  vi.mocked(authHeaders).mockResolvedValue({ authorization: "Bearer old-session" });
  vi.mocked(currentApiBase).mockReturnValue("https://orkbot.example.test");
  vi.mocked(currentSessionGeneration).mockReturnValue(1);
  vi.mocked(clearSpace).mockResolvedValue(true);
  vi.mocked(fetchMobileJson).mockResolvedValue({
    response: Response.json({}),
    body: { user: { id: "user-1" } },
  });
  vi.mocked(fetchMobileJson).mockResolvedValueOnce({
    response: new Response(null, {
      headers: { "set-cookie": "better-auth.oauth_state=encrypted-state; Path=/; HttpOnly" },
    }),
    body: { url: "https://identity.example.test/authorize?state=test-state" },
  });
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `orkbot://sign-in?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
  });
});
afterEach(() => vi.restoreAllMocks());
it("uses the Expo proxy, validates the session, and saves the existing session store", async () => {
  await expect(continueWithSso()).resolves.toBe(true);
  const [url, callback] = vi.mocked(openAuthSessionAsync).mock.calls[0]!;
  expect(callback).toBe("orkbot://sign-in");
  expect(new URL(url).pathname).toBe("/api/auth/expo-authorization-proxy");
  expect(new URL(url).searchParams.get("oauthState")).toBe("encrypted-state");
  expect(replaceSessionTokenIfCurrent).toHaveBeenCalledWith(1, "new-session", "sign_in");
  expect(clearSpace).toHaveBeenCalledOnce();
});
it.each([WebBrowserResultType.CANCEL, WebBrowserResultType.DISMISS])(
  "does not store a session on %s",
  async (type) => {
    vi.mocked(openAuthSessionAsync).mockResolvedValue({ type });
    await expect(continueWithSso()).resolves.toBe(false);
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  },
);
it.each([
  "https://attacker.example.test/?cookie=token",
  "orkbot://sign-in?error=account_not_linked",
  "orkbot://sign-in",
])("rejects invalid callbacks", async (url) => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({ type: "success", url });
  await expect(continueWithSso()).rejects.toThrow();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it.each(["server", "session"])("drops results when the %s changes", async (changed) => {
  vi.mocked(openAuthSessionAsync).mockImplementation(async () => {
    if (changed === "server")
      vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
    else vi.mocked(currentSessionGeneration).mockReturnValue(2);
    return {
      type: "success",
      url: `orkbot://sign-in?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
    };
  });
  await expect(continueWithSso()).rejects.toThrow();
  expect(fetchMobileJson).toHaveBeenCalledOnce();
  expect(clearSpace).not.toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("requires reauthentication to return the same account", async () => {
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "user-1" } } })
    .mockResolvedValueOnce({
      response: Response.json({}),
      body: { url: "https://identity.example.test/authorize?state=test-state" },
    })
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "other-user" } } });
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `orkbot://account?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
  });
  await expect(continueWithSso("reauthenticate")).rejects.toThrow();
  expect(authHeaders).toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("starts authenticated linking without replacing the session", async () => {
  vi.mocked(openAuthSessionAsync).mockResolvedValue({ type: "success", url: "orkbot://account" });
  await expect(continueWithSso("link")).resolves.toBe(true);
  expect(vi.mocked(fetchMobileJson).mock.calls[0]?.[0]).toContain("/link-social");
  expect(vi.mocked(fetchMobileJson).mock.calls[0]?.[1]?.headers).toMatchObject({
    authorization: "Bearer old-session",
  });
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
});

it("does not send a different server's token during authenticated linking", async () => {
  vi.mocked(authHeaders).mockImplementationOnce(async () => {
    vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
    return { authorization: "Bearer other-server-session" };
  });
  await expect(continueWithSso("link")).rejects.toThrow();
  expect(fetchMobileJson).not.toHaveBeenCalled();
  expect(openAuthSessionAsync).not.toHaveBeenCalled();
});

it("explains technical session persistence failures", async () => {
  vi.mocked(replaceSessionTokenIfCurrent).mockRejectedValueOnce(new Error("SecureStoreException"));
  await expect(continueWithSso()).rejects.toThrow(
    "Could not save your sign-in on this device. Try again.",
  );
});
it("maps an unavailable session endpoint", async () => {
  vi.mocked(fetchMobileJson).mockResolvedValueOnce({
    response: new Response(null, { status: 503 }),
    body: {},
  });
  await expect(continueWithSso()).rejects.toThrow("Could not reach the server");
});

function sameAccountReauthentication() {
  vi.mocked(fetchMobileJson).mockReset();
  vi.mocked(fetchMobileJson)
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "user-1" } } })
    .mockResolvedValueOnce({
      response: Response.json({}),
      body: { url: "https://identity.example.test/authorize?state=test-state" },
    })
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "user-1" } } });
  vi.mocked(openAuthSessionAsync).mockResolvedValue({
    type: "success",
    url: `orkbot://account?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
  });
}
it("rotates a verified same-account SSO token using the bearer that established its previous identity", async () => {
  sameAccountReauthentication();
  await expect(continueWithSso("reauthenticate")).resolves.toBe(true);
  expect(rotateSessionTokenIfCurrent).toHaveBeenCalledExactlyOnceWith(
    1,
    "old-session",
    "new-session",
    "reauthentication",
  );
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(clearSpace).not.toHaveBeenCalled();
  expect(vi.mocked(fetchMobileJson).mock.calls[0]?.[1]?.headers).toMatchObject({
    authorization: "Bearer old-session",
  });
  expect(vi.mocked(fetchMobileJson).mock.calls[2]?.[1]?.headers).toMatchObject({
    authorization: "Bearer new-session",
  });
});
it.each([
  {},
  { authorization: "" },
  { authorization: "Bearer " },
  { authorization: "Basic old-session" },
])("does not preserve data without a previous bearer (%j)", async (headers) => {
  sameAccountReauthentication();
  vi.mocked(authHeaders).mockResolvedValue(headers as Record<string, string>);
  await expect(continueWithSso("reauthenticate")).rejects.toThrow("Could not continue");
  expect(fetchMobileJson).not.toHaveBeenCalled();
  expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it.each(["logout", "account", "server", "server-roundtrip"])(
  "cannot rotate after a %s change during reauthentication",
  async (change) => {
    sameAccountReauthentication();
    vi.mocked(openAuthSessionAsync).mockImplementation(async () => {
      if (change === "server")
        vi.mocked(currentApiBase).mockReturnValue("https://other.example.test");
      else vi.mocked(currentSessionGeneration).mockReturnValue(2);
      return {
        type: "success",
        url: `orkbot://account?cookie=${encodeURIComponent("better-auth.session_token=new-session; Path=/; HttpOnly")}`,
      };
    });
    await expect(continueWithSso("reauthenticate")).rejects.toThrow("Could not continue");
    expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
    expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  },
);
it("checks session ownership again after validation of the returned account", async () => {
  sameAccountReauthentication();
  // The first two reads identify the old account and start OAuth; only the final read stalls.
  vi.mocked(fetchMobileJson)
    .mockReset()
    .mockResolvedValueOnce({ response: Response.json({}), body: { user: { id: "user-1" } } })
    .mockResolvedValueOnce({
      response: Response.json({}),
      body: { url: "https://identity.example.test/authorize?state=test-state" },
    });
  let finish!: (result: { response: Response; body: { user: { id: string } } }) => void;
  vi.mocked(fetchMobileJson).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const result = continueWithSso("reauthenticate").catch((error: unknown) => error);
  await vi.waitFor(() => expect(fetchMobileJson).toHaveBeenCalledTimes(3));
  vi.mocked(currentSessionGeneration).mockReturnValue(2);
  finish({ response: Response.json({}), body: { user: { id: "user-1" } } });
  expect(await result).toBeInstanceOf(Error);
  expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("returns a refused late rotation without falling back to destructive replacement", async () => {
  sameAccountReauthentication();
  vi.mocked(rotateSessionTokenIfCurrent).mockResolvedValue(false);
  await expect(continueWithSso("reauthenticate")).resolves.toBe(false);
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
});
it("reports a failed reauthentication save without replacing the preserved namespace", async () => {
  sameAccountReauthentication();
  vi.mocked(rotateSessionTokenIfCurrent).mockRejectedValue(new Error("SecureStoreException"));
  await expect(continueWithSso("reauthenticate")).rejects.toThrow(
    "Could not save your sign-in on this device. Try again.",
  );
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(clearSpace).not.toHaveBeenCalled();
});

it("does not replace or rotate an authenticated link after logout wins", async () => {
  vi.mocked(openAuthSessionAsync).mockImplementation(async () => {
    vi.mocked(currentSessionGeneration).mockReturnValue(2);
    return { type: "success", url: "orkbot://account" };
  });
  await expect(continueWithSso("link")).rejects.toThrow("Could not continue");
  expect(replaceSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(rotateSessionTokenIfCurrent).not.toHaveBeenCalled();
  expect(clearSpace).not.toHaveBeenCalled();
});
