// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  options: vi.fn(),
  prompt: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  extra: { accountsIssuer: "https://accounts.example.test", accountsClientId: "mobile-client" },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: mocks.extra } } }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: mocks.get,
  setItemAsync: mocks.set,
  deleteItemAsync: mocks.remove,
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "nonce-value" }));
vi.mock("expo-auth-session", () => ({
  AuthRequest: class {
    state = "state-value";
    codeVerifier = "verifier-value";
    constructor(options: unknown) {
      mocks.options(options);
    }
    async makeAuthUrlAsync() {
      return "https://accounts.example.test/authorize";
    }
    promptAsync = mocks.prompt;
  },
  ResponseType: { Code: "code" },
  CodeChallengeMethod: { S256: "S256" },
}));

const issuer = "https://accounts.example.test";
const redirect = "run.orkbot.app:/oauth2/callback";
const storageKey = "orkbot.accounts.tokens";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  userinfo_endpoint: `${issuer}/userinfo`,
  jwks_uri: `${issuer}/jwks`,
  revocation_endpoint: `${issuer}/revoke`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  response_types_supported: ["code"],
  id_token_signing_alg_values_supported: ["RS256"],
  authorization_response_iss_parameter_supported: true,
};
let claims: Record<string, unknown>;
let responseTokens: Record<string, unknown>;
let userSub = "subject-1";
let tokenHandler: (() => Promise<Response>) | undefined;
let fetched: ReturnType<typeof vi.fn>;

function jwt(overrides = {}, headerOverrides = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", kid: "key-1", ...headerOverrides })}.${encode({ ...claims, ...overrides })}`;
  return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url")}`;
}
function stored(expiresAt = Date.now() - 1000) {
  mocks.storage.set(
    storageKey,
    JSON.stringify({
      issuer,
      clientId: "mobile-client",
      subject: "subject-1",
      nonce: "nonce-value",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt,
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.storage.clear();
  mocks.extra.accountsIssuer = issuer;
  mocks.extra.accountsClientId = "mobile-client";
  mocks.get.mockReset().mockImplementation(async (key) => mocks.storage.get(key) ?? null);
  mocks.set.mockReset().mockImplementation(async (key, value) => {
    mocks.storage.set(key, value);
  });
  mocks.remove.mockReset().mockImplementation(async (key) => {
    mocks.storage.delete(key);
  });
  mocks.prompt.mockReset().mockResolvedValue({
    type: "success",
    url: `${redirect}?code=auth-code&state=state-value&iss=${encodeURIComponent(issuer)}`,
  });
  const now = Math.floor(Date.now() / 1000);
  claims = {
    iss: issuer,
    aud: "mobile-client",
    sub: "subject-1",
    nonce: "nonce-value",
    iat: now,
    exp: now + 3600,
  };
  responseTokens = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  };
  userSub = "subject-1";
  tokenHandler = undefined;
  fetched = vi.fn(async (url: string) => {
    if (url.endsWith("openid-configuration")) return Response.json(metadata);
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/userinfo")) return Response.json({ sub: userSub });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (url.endsWith("/token"))
      return tokenHandler ? tokenHandler() : Response.json({ ...responseTokens, id_token: jwt() });
    throw new Error("Unexpected URL");
  });
  vi.stubGlobal("fetch", fetched);
});
afterEach(() => vi.unstubAllGlobals());

it("requests explicit consent with Expo S256 and saves verified tokens in device-only SecureStore", async () => {
  const { continueWithAccounts } = await import("./accounts");
  await expect(continueWithAccounts()).resolves.toBe(true);
  expect(mocks.options).toHaveBeenCalledWith(
    expect.objectContaining({
      redirectUri: redirect,
      usePKCE: true,
      codeChallengeMethod: "S256",
      responseType: "code",
      scopes: ["openid", "email", "profile", "offline_access"],
      extraParams: { prompt: "consent", nonce: "nonce-value" },
    }),
  );
  const exchange = fetched.mock.calls.find(([url]) => url.endsWith("/token"))!;
  const body = new URLSearchParams(
    (exchange as unknown as [string, RequestInit])[1].body as string,
  );
  expect(Object.fromEntries(body)).toEqual({
    client_id: "mobile-client",
    grant_type: "authorization_code",
    code: "auth-code",
    redirect_uri: redirect,
    code_verifier: "verifier-value",
  });
  expect(mocks.set).toHaveBeenCalledWith(storageKey, expect.any(String), {
    keychainAccessible: "device-only",
  });
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({
    accessToken: "new-access",
    refreshToken: "new-refresh",
    subject: "subject-1",
  });
});

it.each([
  `${redirect}?code=x&state=wrong&iss=${issuer}`,
  `${redirect}?code=x&state=state-value&iss=https://evil.example.test`,
  `${redirect}?code=x&state=state-value`,
  `${redirect}?code=x&code=y&state=state-value&iss=${issuer}`,
  `${redirect}?code=x&state=state-value&state=state-value&iss=${issuer}`,
  `run.orkbot.app://oauth2/callback?code=x&state=state-value&iss=${issuer}`,
  `${redirect}?code=x&state=state-value&iss=${issuer}#fragment`,
])("rejects an invalid callback before token exchange: %s", async (url) => {
  const { continueWithAccounts } = await import("./accounts");
  mocks.prompt.mockResolvedValue({ type: "success", url });
  await expect(continueWithAccounts()).rejects.toThrow();
  expect(fetched.mock.calls.some(([url]) => url.endsWith("/token"))).toBe(false);
  expect(mocks.set).not.toHaveBeenCalled();
});

it.each([
  { nonce: "wrong" },
  { iss: "https://evil.example.test" },
  { aud: "other-client" },
  { aud: ["mobile-client", "other-client"] },
  { azp: "other-client" },
  { sub: "" },
  { exp: 0 },
  { iat: 9_999_999_999 },
  { at_hash: "wrong" },
])("rejects signed ID tokens with invalid claims %j", async (overrides) => {
  const { continueWithAccounts } = await import("./accounts");
  claims = { ...claims, ...overrides };
  await expect(continueWithAccounts()).rejects.toThrow();
  expect(mocks.set).not.toHaveBeenCalled();
});

it("rejects a forged signature", async () => {
  const { continueWithAccounts } = await import("./accounts");
  tokenHandler = async () =>
    Response.json({
      ...responseTokens,
      id_token: `${jwt().split(".").slice(0, 2).join(".")}.${Buffer.alloc(256).toString("base64url")}`,
    });
  await expect(continueWithAccounts()).rejects.toThrow();
  expect(mocks.set).not.toHaveBeenCalled();
});

it("rejects userinfo for a different signed subject", async () => {
  const { continueWithAccounts } = await import("./accounts");
  userSub = "different-subject";
  await expect(continueWithAccounts()).rejects.toThrow("different user profile");
  expect(mocks.set).not.toHaveBeenCalled();
});

it("coalesces refresh and atomically saves the rotated refresh token", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  await expect(Promise.all([accountsAccessToken(), accountsAccessToken()])).resolves.toEqual([
    "new-access",
    "new-access",
  ]);
  expect(fetched.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(1);
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ refreshToken: "new-refresh" });
});

it("keeps a valid stored bearer and returns null without refresh capability", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored(Date.now() + 3600_000);
  await expect(accountsAccessToken()).resolves.toBe("old-access");
  const previous = JSON.parse(mocks.storage.get(storageKey)!);
  mocks.storage.set(
    storageKey,
    JSON.stringify({ ...previous, expiresAt: 0, refreshToken: undefined }),
  );
  await expect(accountsAccessToken()).resolves.toBeNull();
  expect(fetched).not.toHaveBeenCalled();
});

it("clears a rejected refresh token and requires browser sign-in", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  tokenHandler = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await expect(accountsAccessToken()).resolves.toBeNull();
  expect(mocks.storage.has(storageKey)).toBe(false);
});

it("does not reuse a rotating refresh token after a transport failure or failed persistence", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  mocks.set.mockRejectedValue(new Error("SecureStore failed"));
  await expect(accountsAccessToken()).rejects.toThrow("Sign in again");
  await expect(accountsAccessToken()).resolves.toBeNull();
  expect(fetched.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(1);
});

it("drops a refresh result after logout and revokes best effort", async () => {
  const { accountsAccessToken, signOutAccounts } = await import("./accounts");
  stored();
  let finish!: (value: Response) => void;
  let reached!: () => void;
  const reachedToken = new Promise<void>((resolve) => {
    reached = resolve;
  });
  tokenHandler = () => {
    reached();
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const pending = accountsAccessToken();
  await reachedToken;
  await signOutAccounts();
  finish(Response.json({ ...responseTokens, id_token: jwt() }));
  await expect(pending).resolves.toBeNull();
  expect(mocks.storage.has(storageKey)).toBe(false);
  expect(fetched.mock.calls.some(([url]) => url.endsWith("/revoke"))).toBe(true);
});

it("finishes local logout while optional revocation stalls and preserves a newer login", async () => {
  const { accountsAccessToken, continueWithAccounts, signOutAccounts } = await import("./accounts");
  stored(Date.now() + 3600_000);
  let release!: (response: Response) => void;
  let reached!: () => void;
  const revoking = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const request = fetched.getMockImplementation()! as (url: string) => Promise<Response>;
  fetched.mockImplementation(async (url: string) => {
    if (!url.endsWith("/revoke")) return request(url);
    reached();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  let completed = false;
  const logout = signOutAccounts().then(() => {
    completed = true;
  });
  await revoking;
  await Promise.resolve();
  await Promise.resolve();
  try {
    expect(completed).toBe(true);
    expect(mocks.storage.has(storageKey)).toBe(false);
    await expect(accountsAccessToken()).resolves.toBeNull();
    await expect(continueWithAccounts()).resolves.toBe(true);
  } finally {
    release(new Response(null, { status: 200 }));
    await logout;
  }
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ accessToken: "new-access" });
});

it("clears local tokens with missing config or an unreadable credential snapshot", async () => {
  const { signOutAccounts } = await import("./accounts");
  stored();
  mocks.extra.accountsClientId = "";
  mocks.get.mockRejectedValueOnce(new Error("unreadable"));
  await expect(signOutAccounts()).resolves.toBeUndefined();
  expect(mocks.remove).toHaveBeenCalledWith(storageKey);
  expect(mocks.storage.has(storageKey)).toBe(false);
});

it("fails clearly when Accounts build configuration is missing", async () => {
  const { continueWithAccounts } = await import("./accounts");
  mocks.extra.accountsClientId = "";
  await expect(continueWithAccounts()).rejects.toThrow("ORK_ACCOUNTS");
  expect(fetched).not.toHaveBeenCalled();
});

it("does not save credentials when the browser session is cancelled", async () => {
  const { continueWithAccounts } = await import("./accounts");
  mocks.prompt.mockResolvedValue({ type: "cancel" });
  await expect(continueWithAccounts()).resolves.toBe(false);
  expect(mocks.set).not.toHaveBeenCalled();
});

it("accepts refresh responses without a new ID token and keeps the existing subject", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  tokenHandler = async () => Response.json(responseTokens);
  await expect(accountsAccessToken()).resolves.toBe("new-access");
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ subject: "subject-1" });
});

it("clears a rotating refresh token after an ambiguous network response", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  tokenHandler = async () => {
    throw new Error("Connection closed");
  };
  await expect(accountsAccessToken()).rejects.toThrow("Could not reach Accounts. Try again.");
  await expect(accountsAccessToken()).resolves.toBeNull();
  expect(fetched.mock.calls.filter(([url]) => url.endsWith("/token"))).toHaveLength(1);
});

it("rejects a refreshed ID token for another account and forgets the rotating predecessor", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  claims.sub = "other-subject";
  await expect(accountsAccessToken()).rejects.toThrow("changed the signed-in account");
  expect(mocks.storage.has(storageKey)).toBe(false);
});

it("keeps a newer sign-in when it starts during a logout storage read", async () => {
  const { continueWithAccounts, signOutAccounts } = await import("./accounts");
  stored();
  const previous = mocks.storage.get(storageKey)!;
  let finish!: (value: string) => void;
  let reached!: () => void;
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  mocks.get.mockImplementationOnce(() => {
    reached();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const logout = signOutAccounts();
  await reading;
  const signingIn = continueWithAccounts();
  finish(previous);
  await logout;
  await expect(signingIn).resolves.toBe(true);
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ accessToken: "new-access" });
});

it("does not restore credentials belonging to a different public client", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  mocks.extra.accountsClientId = "other-client";
  await expect(accountsAccessToken()).resolves.toBeNull();
  expect(fetched).not.toHaveBeenCalled();
});

it("retires the rotating predecessor before the provider can consume it", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  tokenHandler = async () => {
    expect(mocks.storage.has(storageKey)).toBe(false);
    return Response.json(responseTokens);
  };
  await expect(accountsAccessToken()).resolves.toBe("new-access");
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ refreshToken: "new-refresh" });
});

it("does not send a refresh token if the predecessor cannot be retired", async () => {
  const { accountsAccessToken } = await import("./accounts");
  stored();
  mocks.remove.mockRejectedValue(new Error("delete failed"));
  mocks.set.mockRejectedValue(new Error("overwrite failed"));
  await expect(accountsAccessToken()).rejects.toThrow("overwrite failed");
  expect(fetched.mock.calls.some(([url]) => url.endsWith("/token"))).toBe(false);
});

it("passes a welcome seed only as a cosmetic hint and restores the account's own seed", async () => {
  const preview = "64cf5621-3144-4810-97f5-148acdc29c35";
  const saved = "f4c2f322-7b3b-4a53-a44c-47647614fdc0";
  const original = fetched.getMockImplementation() as (
    url: string,
    ...rest: unknown[]
  ) => Promise<Response>;
  fetched.mockImplementation(async (url: string, ...rest: unknown[]) =>
    url.endsWith("/userinfo")
      ? Response.json({ sub: userSub, ork_avatar: saved })
      : original(url, ...rest),
  );
  const { continueWithAccounts, accountsIdentity } = await import("./accounts");
  await expect(continueWithAccounts(preview)).resolves.toBe(true);
  expect(mocks.options).toHaveBeenCalledWith(
    expect.objectContaining({
      extraParams: { prompt: "consent", nonce: "nonce-value", ork_avatar: preview },
    }),
  );
  expect(await accountsIdentity()).toEqual({ issuer, subject: userSub, orkAvatar: saved });
  expect(JSON.parse(mocks.storage.get(storageKey)!)).toMatchObject({ orkAvatar: saved });
});

it("does not pass malformed welcome data to Accounts", async () => {
  const { continueWithAccounts } = await import("./accounts");
  await continueWithAccounts("https://untrusted.example.test/seed");
  expect(mocks.options).toHaveBeenCalledWith(
    expect.objectContaining({ extraParams: { prompt: "consent", nonce: "nonce-value" } }),
  );
});

it("ignores malformed account avatar metadata without exposing it to the renderer", async () => {
  const original = fetched.getMockImplementation() as (
    url: string,
    ...rest: unknown[]
  ) => Promise<Response>;
  fetched.mockImplementation(async (url: string, ...rest: unknown[]) =>
    url.endsWith("/userinfo")
      ? Response.json({ sub: userSub, ork_avatar: "https://untrusted.example.test/avatar.svg" })
      : original(url, ...rest),
  );
  const { continueWithAccounts, accountsIdentity } = await import("./accounts");
  await continueWithAccounts("64cf5621-3144-4810-97f5-148acdc29c35");
  expect(await accountsIdentity()).toEqual({ issuer, subject: userSub });
  expect(JSON.parse(mocks.storage.get(storageKey)!)).not.toHaveProperty("orkAvatar");
});
