// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

export interface AccountsConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
}

export interface AccountsDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  revocation_endpoint?: string;
  authorization_response_iss_parameter_supported: boolean;
  id_token_signing_alg_values_supported: string[];
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Accounts requires an HTTPS URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Accounts requires an HTTPS URL without credentials or fragments.");
  return value;
}

/** Configuration is explicit so self-hosted apps never silently connect to another issuer. */
export function accountsConfig(input: { issuer?: string; clientId?: string }): AccountsConfig {
  if (!input.issuer || !input.clientId?.trim())
    throw new Error("Set ORK_ACCOUNTS_ISSUER and the platform's ORK_ACCOUNTS client ID.");
  const issuer = httpsUrl(input.issuer);
  if (new URL(issuer).search) throw new Error("Accounts issuer must not contain a query.");
  return {
    issuer,
    clientId: input.clientId.trim(),
    scopes: ["openid", "email", "profile", "offline_access"],
  };
}

/** Cache only validated discovery for five minutes, coalescing requests for the same issuer. */
export function createAccountsDiscovery(fetcher: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; value: Promise<AccountsDiscovery> }>();
  return (config: AccountsConfig): Promise<AccountsDiscovery> => {
    const cached = cache.get(config.issuer);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = (async () => {
      const response = await fetcher(
        `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(8_000), redirect: "error" },
      );
      if (!response.ok) throw new Error("Accounts discovery is unavailable.");
      const data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Accounts discovery is invalid.");
      const body = data as Record<string, unknown>;
      if (
        !body ||
        body.issuer !== config.issuer ||
        !Array.isArray(body.code_challenge_methods_supported) ||
        !body.code_challenge_methods_supported.includes("S256") ||
        !Array.isArray(body.token_endpoint_auth_methods_supported) ||
        !body.token_endpoint_auth_methods_supported.includes("none") ||
        !Array.isArray(body.response_types_supported) ||
        !body.response_types_supported.includes("code") ||
        !Array.isArray(body.id_token_signing_alg_values_supported) ||
        !body.id_token_signing_alg_values_supported.includes("RS256")
      )
        throw new Error(
          "Accounts discovery must match the issuer and support public S256 code flow with RS256.",
        );
      return {
        issuer: config.issuer,
        authorization_endpoint: httpsUrl(body.authorization_endpoint),
        token_endpoint: httpsUrl(body.token_endpoint),
        jwks_uri: httpsUrl(body.jwks_uri),
        userinfo_endpoint: httpsUrl(body.userinfo_endpoint),
        ...(body.revocation_endpoint
          ? { revocation_endpoint: httpsUrl(body.revocation_endpoint) }
          : {}),
        authorization_response_iss_parameter_supported:
          body.authorization_response_iss_parameter_supported === true,
        id_token_signing_alg_values_supported: body.id_token_signing_alg_values_supported.filter(
          (value: unknown): value is string => typeof value === "string",
        ),
      };
    })();
    cache.set(config.issuer, { expires: Date.now() + 300_000, value });
    void value.catch(() => {
      if (cache.get(config.issuer)?.value === value) cache.delete(config.issuer);
    });
    return value;
  };
}

/** Check the raw redirect before a library can collapse repeated query parameters. */
export function validateAccountsCallback(
  callbackUrl: string,
  redirectUri: string,
  state: string,
  issuer: string,
  requireIssuer = true,
): string {
  const callback = new URL(callbackUrl);
  const redirect = new URL(redirectUri);
  const values = (key: string) => callback.searchParams.getAll(key);
  if (
    callback.protocol !== redirect.protocol ||
    callback.host !== redirect.host ||
    callback.pathname !== redirect.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    redirect.search ||
    redirect.hash ||
    !state ||
    values("state").length !== 1 ||
    values("state")[0] !== state ||
    values("iss").length > 1 ||
    (requireIssuer && values("iss").length !== 1) ||
    (values("iss").length === 1 && values("iss")[0] !== issuer) ||
    callback.searchParams.has("error") ||
    values("code").length !== 1 ||
    !values("code")[0]
  )
    throw new Error("Accounts returned an invalid sign-in callback.");
  return values("code")[0]!;
}
