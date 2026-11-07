// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { AccountsDiscovery } from "@orkbot/contracts/accounts";
import {
  accountsConfig,
  createAccountsDiscovery,
  validateAccountsCallback,
} from "@orkbot/contracts/accounts";
import { createPersonalOrkId, isPersonalOrkId, readBoundedJsonResponse } from "@orkbot/core";
import * as SecureStore from "expo-secure-store";
import { queueAccountsRevocation, retryPendingRevocations } from "./pending-revocations";
import { clearServerInitialization } from "./server-connect";

export const ACCOUNTS_REDIRECT_URI = "run.orkbot.app:/oauth2/callback";
const STORAGE_KEY = "orkbot.accounts.tokens";
const welcomeOrk = createPersonalOrkId();

/** Retained through native auth screen remounts for this application launch. */
export const welcomeAccountsOrk = () => welcomeOrk;
const discover = createAccountsDiscovery();

type Config = ReturnType<typeof accountsConfig>;
type Tokens = {
  issuer: string;
  clientId: string;
  subject: string;
  nonce: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  orkAvatar?: string;
};

let generation = 0;
let invalidated = false;
let writes: Promise<unknown> = Promise.resolve();
let signingIn = false;
let refreshing: Promise<string | null> | undefined;
let refreshSnapshot: Tokens | undefined;
let accountVersion = 0;
const accountListeners = new Set<() => void>();

export function subscribeAccounts(listener: () => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

export const accountsVersion = () => accountVersion;

function accountChanged() {
  accountVersion += 1;
  for (const listener of accountListeners) listener();
}

async function config(): Promise<Config> {
  const { default: Constants } = await import("expo-constants");
  return accountsConfig({
    issuer: Constants.expoConfig?.extra?.accountsIssuer,
    clientId: Constants.expoConfig?.extra?.accountsClientId,
  });
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation, operation);
  writes = next.catch(() => undefined);
  return next;
}

async function load(expected: Config): Promise<Tokens | null> {
  if (invalidated) return null;
  await writes;
  const value = await SecureStore.getItemAsync(STORAGE_KEY);
  if (!value || invalidated) return null;
  let tokens: Tokens;
  try {
    tokens = JSON.parse(value);
  } catch {
    throw new Error("Could not read the Accounts credentials on this device.");
  }
  if (
    tokens.issuer !== expected.issuer ||
    tokens.clientId !== expected.clientId ||
    typeof tokens.subject !== "string" ||
    !tokens.subject ||
    typeof tokens.nonce !== "string" ||
    !tokens.nonce ||
    typeof tokens.accessToken !== "string" ||
    !tokens.accessToken ||
    typeof tokens.expiresAt !== "number" ||
    !Number.isFinite(tokens.expiresAt) ||
    (tokens.refreshToken !== undefined && typeof tokens.refreshToken !== "string")
  )
    return null;
  return tokens;
}

async function clearStored(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {
    await SecureStore.setItemAsync(STORAGE_KEY, "");
  }
}

async function save(tokens: Tokens, owner: number): Promise<boolean> {
  return enqueue(async () => {
    if (owner !== generation) return false;
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tokens), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      invalidated = true;
      // A rotating refresh token may already be consumed. Never reuse the stored predecessor.
      await clearStored().catch(() => undefined);
      throw new Error("Could not save the Accounts credentials on this device. Sign in again.");
    }
    if (owner !== generation) return false;
    invalidated = false;
    return true;
  });
}

async function requestJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const signal = AbortSignal.timeout(15_000);
  const response = await fetch(url, {
    ...init,
    credentials: "omit",
    redirect: "error",
    signal,
  });
  let value: unknown;
  try {
    value = await readBoundedJsonResponse<unknown>(response, 128 * 1024, signal);
  } catch {
    throw new Error("Accounts returned an invalid response.");
  }
  if (!response.ok) {
    if (value && typeof value === "object" && "error" in value && value.error === "invalid_grant") {
      throw new InvalidGrantError();
    }
    throw new Error("Could not reach Accounts. Try again.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Accounts returned an invalid response.");
  return value as Record<string, unknown>;
}

class InvalidGrantError extends Error {}

/** Signature verification uses portable RSA, without depending on Hermes WebCrypto support. */
export async function verifyAccountsIdToken(
  token: string,
  metadata: AccountsDiscovery,
  expected: Config,
  nonce: string,
  requireNonce: boolean,
  accessToken?: string,
): Promise<string> {
  const forge = (await import("node-forge")).default;
  const bytes = (value: string) =>
    forge.util.decode64(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
  const decode = (value: string) => JSON.parse(forge.util.decodeUtf8(bytes(value)));
  if (token.length > 64 * 1024 || token.split(".").length !== 3)
    throw new Error("Accounts returned an invalid ID token.");
  const parts = token.split(".");
  const header = decode(parts[0]!);
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    !header.kid ||
    header.crit !== undefined ||
    header.b64 !== undefined ||
    !metadata.id_token_signing_alg_values_supported.includes("RS256")
  )
    throw new Error("Accounts returned an unsupported ID token.");
  const jwks = await requestJson(metadata.jwks_uri);
  if (!Array.isArray(jwks.keys)) throw new Error("Accounts returned invalid signing keys.");
  const keys = jwks.keys.filter(
    (key: Record<string, unknown>) =>
      key &&
      key.kid === header.kid &&
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256") &&
      (key.key_ops === undefined ||
        (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))) &&
      typeof key.n === "string" &&
      typeof key.e === "string" &&
      /^[A-Za-z0-9_-]+$/.test(key.n) &&
      /^[A-Za-z0-9_-]+$/.test(key.e) &&
      bytes(key.n).length >= 256 &&
      bytes(key.n).length <= 1024 &&
      key.d === undefined,
  );
  if (keys.length !== 1) throw new Error("Accounts returned invalid signing keys.");
  const key = keys[0];
  const publicKey = forge.pki.rsa.setPublicKey(
    new forge.jsbn.BigInteger(forge.util.bytesToHex(bytes(key.n)), 16),
    new forge.jsbn.BigInteger(forge.util.bytesToHex(bytes(key.e)), 16),
  );
  if (
    publicKey.n.bitLength() < 2048 ||
    publicKey.e.compareTo(new forge.jsbn.BigInteger("3")) < 0 ||
    publicKey.e.intValue() % 2 === 0 ||
    publicKey.e.bitLength() > 32
  )
    throw new Error("Accounts returned an invalid RSA signing key.");
  const digest = forge.md.sha256
    .create()
    .update(`${parts[0]}.${parts[1]}`, "utf8")
    .digest()
    .getBytes();
  if (!publicKey.verify(digest, bytes(parts[2]!)))
    throw new Error("Accounts returned an invalid ID token signature.");
  const claims = decode(parts[1]!);
  const now = Math.floor(Date.now() / 1000);
  const accessHash = accessToken
    ? forge.util
        .encode64(
          forge.md.sha256.create().update(accessToken, "utf8").digest().getBytes().slice(0, 16),
        )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
    : undefined;
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    claims.iss !== expected.issuer ||
    !Array.isArray(audience) ||
    !audience.every((item) => typeof item === "string") ||
    !audience.includes(expected.clientId) ||
    (audience.length > 1 && claims.azp !== expected.clientId) ||
    (claims.azp !== undefined && claims.azp !== expected.clientId) ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now ||
    typeof claims.iat !== "number" ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + 60 ||
    claims.iat > claims.exp ||
    (claims.nbf !== undefined &&
      (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60)) ||
    (claims.at_hash !== undefined && claims.at_hash !== accessHash) ||
    (requireNonce && claims.nonce !== nonce) ||
    (claims.nonce !== undefined && claims.nonce !== nonce)
  )
    throw new Error("Accounts returned invalid ID token claims.");
  return claims.sub;
}

async function exchange(
  metadata: AccountsDiscovery,
  expected: Config,
  parameters: Record<string, string>,
  nonce: string,
  previous?: Tokens,
): Promise<Tokens> {
  const body = await requestJson(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: expected.clientId, ...parameters }).toString(),
  });
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    typeof body.token_type !== "string" ||
    body.token_type.toLowerCase() !== "bearer" ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    body.expires_in > 31_536_000 ||
    (body.refresh_token !== undefined &&
      (typeof body.refresh_token !== "string" || !body.refresh_token)) ||
    (!previous && typeof body.id_token !== "string") ||
    (body.id_token !== undefined && typeof body.id_token !== "string")
  )
    throw new Error("Accounts returned invalid tokens.");
  const subject =
    typeof body.id_token === "string"
      ? await verifyAccountsIdToken(
          body.id_token,
          metadata,
          expected,
          nonce,
          !previous,
          body.access_token,
        )
      : previous!.subject;
  if (previous && subject !== previous.subject)
    throw new Error("Accounts changed the signed-in account.");
  const user = await requestJson(metadata.userinfo_endpoint, {
    headers: { authorization: `Bearer ${body.access_token}` },
  });
  if (user.sub !== subject) throw new Error("Accounts returned a different user profile.");
  return {
    issuer: expected.issuer,
    clientId: expected.clientId,
    subject,
    nonce,
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : previous?.refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    ...(isPersonalOrkId(user.ork_avatar) ? { orkAvatar: user.ork_avatar } : {}),
  };
}

/** Connects the device to Accounts. The selected server's Better Auth session stays separate. */
export async function continueWithAccounts(welcomeOrk?: string): Promise<boolean> {
  if (signingIn) return false;
  signingIn = true;
  const owner = ++generation;
  try {
    const expected = await config();
    const metadata = await discover(expected);
    const { AuthRequest, ResponseType, CodeChallengeMethod } = await import("expo-auth-session");
    const { randomUUID } = await import("expo-crypto");
    const nonce = randomUUID();
    const request = new AuthRequest({
      clientId: expected.clientId,
      redirectUri: ACCOUNTS_REDIRECT_URI,
      scopes: expected.scopes,
      responseType: ResponseType.Code,
      usePKCE: true,
      codeChallengeMethod: CodeChallengeMethod.S256,
      extraParams: {
        prompt: "consent",
        nonce,
        ...(isPersonalOrkId(welcomeOrk) ? { ork_avatar: welcomeOrk } : {}),
      },
    });
    const discovery = { authorizationEndpoint: metadata.authorization_endpoint };
    await request.makeAuthUrlAsync(discovery);
    if (owner !== generation) return false;
    const result = await request.promptAsync(discovery);
    if (result.type === "cancel" || result.type === "dismiss") return false;
    if (result.type !== "success" || !result.url || !request.codeVerifier)
      throw new Error("Could not complete Accounts sign-in.");
    const code = validateAccountsCallback(
      result.url,
      ACCOUNTS_REDIRECT_URI,
      request.state,
      expected.issuer,
      metadata.authorization_response_iss_parameter_supported,
    );
    if (owner !== generation) return false;
    const tokens = await exchange(
      metadata,
      expected,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: ACCOUNTS_REDIRECT_URI,
        code_verifier: request.codeVerifier,
      },
      nonce,
    );
    const saved = await save(tokens, owner);
    if (saved) accountChanged();
    return saved;
  } finally {
    signingIn = false;
  }
}

/** Returns a valid Accounts bearer, or null when browser sign-in is needed again. */
export async function accountsAccessToken(): Promise<string | null> {
  if (signingIn) return null;
  if (refreshing) return refreshing;
  const task = validAccessToken();
  refreshing = task;
  try {
    return await task;
  } finally {
    if (refreshing === task) refreshing = undefined;
  }
}

export async function accountsAuthorization(): Promise<{
  issuer: string;
  subject: string;
  accessToken: string;
} | null> {
  const owner = generation;
  const token = await accountsAccessToken();
  if (!token || owner !== generation) return null;
  const tokens = await load(await config());
  return owner === generation && tokens?.accessToken === token
    ? { issuer: tokens.issuer, subject: tokens.subject, accessToken: token }
    : null;
}

export async function accountsIdentity(): Promise<{
  issuer: string;
  subject: string;
  orkAvatar?: string;
} | null> {
  const owner = generation;
  const authorization = await accountsAuthorization();
  if (!authorization || owner !== generation) return null;
  const tokens = await load(await config());
  if (owner !== generation || !tokens || tokens.accessToken !== authorization.accessToken)
    return null;
  return {
    issuer: authorization.issuer,
    subject: authorization.subject,
    ...(isPersonalOrkId(tokens.orkAvatar) ? { orkAvatar: tokens.orkAvatar } : {}),
  };
}

async function validAccessToken(): Promise<string | null> {
  const owner = generation;
  const expected = await config();
  const previous = await load(expected);
  if (!previous || owner !== generation) return null;
  if (previous.expiresAt > Date.now() + 60_000) return previous.accessToken;
  if (!previous.refreshToken) return null;
  const metadata = await discover(expected);
  if (owner !== generation) return null;
  // Retire the predecessor before the request: a crash after server-side rotation must not replay it.
  invalidated = true;
  const retired = await enqueue(async () => {
    if (owner !== generation) return false;
    await clearStored();
    return true;
  });
  if (!retired || owner !== generation) return null;
  refreshSnapshot = previous;
  let refreshed: Tokens;
  try {
    refreshed = await exchange(
      metadata,
      expected,
      {
        grant_type: "refresh_token",
        refresh_token: previous.refreshToken,
      },
      previous.nonce,
      previous,
    );
  } catch (error) {
    if (owner !== generation || error instanceof InvalidGrantError) return null;
    throw error;
  } finally {
    if (refreshSnapshot === previous) refreshSnapshot = undefined;
  }
  return (await save(refreshed, owner)) ? refreshed.accessToken : null;
}

/** Clears local tokens before attempting optional revocation; no end-session endpoint is needed. */
export async function signOutAccounts(): Promise<void> {
  clearServerInitialization();
  const pendingRefresh = refreshSnapshot;
  ++generation;
  invalidated = true;
  accountChanged();
  const previous = await enqueue(async () => {
    let stored: string | null = null;
    try {
      stored = await SecureStore.getItemAsync(STORAGE_KEY);
    } catch {
      // An unreadable snapshot only prevents remote revocation, never the local wipe.
    }
    const previous = stored ?? (pendingRefresh ? JSON.stringify(pendingRefresh) : null);
    if (previous) {
      try {
        const tokens = JSON.parse(previous) as Tokens;
        const expected = accountsConfig({ issuer: tokens.issuer, clientId: tokens.clientId });
        await queueAccountsRevocation(
          expected.issuer,
          expected.clientId,
          tokens.refreshToken ?? tokens.accessToken,
          tokens.refreshToken ? "refresh_token" : "access_token",
        );
      } catch {
        // Failed recovery persistence must not retain a live local sign-in.
      }
    }
    await clearStored();
    return previous;
  });
  if (previous) retryPendingRevocations();
}
