// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { describe, expect, it, vi } from "vitest";
import { accountsConfig, createAccountsDiscovery, validateAccountsCallback } from "./accounts.js";

const config = accountsConfig({
  issuer: "https://identity.example.com",
  clientId: "public-client",
});
const metadata = {
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}/authorize`,
  token_endpoint: `${config.issuer}/token`,
  userinfo_endpoint: `${config.issuer}/userinfo`,
  jwks_uri: `${config.issuer}/jwks`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  response_types_supported: ["code"],
  id_token_signing_alg_values_supported: ["RS256"],
  authorization_response_iss_parameter_supported: true,
};

describe("public Accounts configuration and discovery", () => {
  it("requires explicit public configuration and HTTPS", () => {
    expect(() => accountsConfig({})).toThrow("ORK_ACCOUNTS");
    for (const issuer of [
      "http://identity.example.com",
      "https://user:pass@identity.example.com",
      "https://identity.example.com?tenant=other",
      "https://identity.example.com/#fragment",
    ])
      expect(() => accountsConfig({ issuer, clientId: "client" })).toThrow();
    expect(config.scopes).toEqual(["openid", "email", "profile", "offline_access"]);
  });

  it("coalesces discovery and caches only validated metadata", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(metadata)));
    const discover = createAccountsDiscovery(fetcher);
    const [first, second] = await Promise.all([discover(config), discover(config)]);
    expect(first).toBe(second);
    await discover(config);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${config.issuer}/.well-known/openid-configuration`);
  });

  it.each([
    { issuer: `${config.issuer}/` },
    { code_challenge_methods_supported: ["plain"] },
    { token_endpoint_auth_methods_supported: ["client_secret_post"] },
    { id_token_signing_alg_values_supported: ["none"] },
    { token_endpoint: "http://identity.example.com/token" },
    { jwks_uri: "https://user:pass@identity.example.com/jwks" },
  ])("rejects unsafe discovery and retries after failure: %j", async (override) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...metadata, ...override })))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata)));
    const discover = createAccountsDiscovery(fetcher);
    await expect(discover(config)).rejects.toThrow();
    await expect(discover(config)).resolves.toMatchObject({ issuer: config.issuer });
  });

  it("expires discovery without serving stale metadata", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(JSON.stringify(metadata)));
      const discover = createAccountsDiscovery(fetcher);
      await discover(config);
      now.mockReturnValue(300_001);
      await discover(config);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe("Accounts callback", () => {
  const redirect = "run.orkbot.app:/oauth2/callback";
  const query = new URLSearchParams({ state: "state", code: "code", iss: config.issuer });
  it("accepts only the exact redirect and matching state and issuer", () => {
    expect(validateAccountsCallback(`${redirect}?${query}`, redirect, "state", config.issuer)).toBe(
      "code",
    );
  });
  it.each([
    `run.orkbot.app://oauth2/callback?${query}`,
    `${redirect}/?${query}`,
    `${redirect}?${query}&state=other`,
    `${redirect}?${query}&code=other`,
    `${redirect}?${query}&iss=other`,
    `${redirect}?${query}&error=access_denied`,
    `${redirect}?${query}#fragment`,
    `${redirect}?code=code&state=wrong&iss=${config.issuer}`,
    `${redirect}?code=code&state=state`,
  ])("rejects a substituted or ambiguous response: %s", (callback) => {
    expect(() => validateAccountsCallback(callback, redirect, "state", config.issuer)).toThrow();
  });
  it("allows absent issuer only when discovery does not advertise it", () => {
    expect(
      validateAccountsCallback(
        `${redirect}?code=code&state=state`,
        redirect,
        "state",
        config.issuer,
        false,
      ),
    ).toBe("code");
    expect(() =>
      validateAccountsCallback(
        `${redirect}?code=code&state=state&iss=wrong`,
        redirect,
        "state",
        config.issuer,
        false,
      ),
    ).toThrow();
  });
});
