// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 environment tests are preserved. Public-client and discovery configuration coverage are Ork additions.

import { describe, expect, it } from "vitest";
import { loadEnv, loadProductEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://orkbot:orkbot@127.0.0.1:5433/orkbot",
  NODE_ENV: "test",
};

describe("loadEnv", () => {
  it("validates shared MCP discovery limits at startup", () => {
    expect(loadEnv(base).mcpDiscovery).toEqual({ maxTools: 250, maxPages: 20, maxBytes: 16777216 });
    expect(
      loadEnv({
        ...base,
        MCP_DISCOVERY_MAX_TOOLS: "500",
        MCP_DISCOVERY_MAX_PAGES: "30",
        MCP_DISCOVERY_MAX_BYTES: "2097152",
      }).mcpDiscovery,
    ).toEqual({ maxTools: 500, maxPages: 30, maxBytes: 2097152 });
    for (const name of [
      "MCP_DISCOVERY_MAX_TOOLS",
      "MCP_DISCOVERY_MAX_PAGES",
      "MCP_DISCOVERY_MAX_BYTES",
    ])
      expect(() => loadEnv({ ...base, [name]: "0" })).toThrow();
  });
  it("binds managed native instances only with an exact owner key and OIDC", () => {
    const configured = {
      ...base,
      AUTH_PASSWORD_ENABLED: "false",
      OIDC_ISSUER: "https://identity.example.test",
      OIDC_CLIENT_ID: "public-client",
      ORKBOT_DESKTOP_STACK_TOKEN: "cd".repeat(32),
      ORKBOT_DESKTOP_ACCOUNT_KEY: "ab".repeat(32),
    };
    expect(loadEnv(configured).desktopAccountKey).toBe(configured.ORKBOT_DESKTOP_ACCOUNT_KEY);
    expect(loadEnv(base).desktopAccountKey).toBeUndefined();
    for (const key of ["invalid", "AB".repeat(32), "a".repeat(63)])
      expect(() => loadEnv({ ...configured, ORKBOT_DESKTOP_ACCOUNT_KEY: key })).toThrow(
        "ORKBOT_DESKTOP_ACCOUNT_KEY",
      );
    expect(() => loadEnv({ ...configured, ORKBOT_DESKTOP_STACK_TOKEN: undefined })).toThrow(
      "ORKBOT_DESKTOP_ACCOUNT_KEY",
    );
    expect(() => loadEnv({ ...configured, AUTH_PASSWORD_ENABLED: "true" })).toThrow(
      "ORKBOT_DESKTOP_ACCOUNT_KEY",
    );
    expect(() =>
      loadEnv({
        ...configured,
        OIDC_ISSUER: undefined,
        OIDC_CLIENT_ID: undefined,
        AUTH_PASSWORD_ENABLED: "true",
      }),
    ).toThrow("ORKBOT_DESKTOP_ACCOUNT_KEY");
  });

  it("supports native Accounts without operator OIDC credentials", () => {
    const config = {
      ...base,
      AUTH_ACCOUNTS_ENABLED: "true",
      AUTH_PASSWORD_ENABLED: "false",
      ORKBOT_BOOTSTRAP_SECRET: "offline-bootstrap-secret-with-32-characters",
      ORKBOT_DESKTOP_STACK_TOKEN: "cd".repeat(32),
      ORKBOT_DESKTOP_ACCOUNT_KEY: "ab".repeat(32),
    };
    const env = loadEnv(config);
    expect(env.accountsEnabled).toBe(true);
    expect(env.oidc).toBeUndefined();
    expect(env.desktopAccountKey).toBe(config.ORKBOT_DESKTOP_ACCOUNT_KEY);
    expect(env.bootstrapSecret).toBe(config.ORKBOT_BOOTSTRAP_SECRET);
    expect(() => loadEnv({ ...config, AUTH_ACCOUNTS_ENABLED: "yes" })).toThrow(
      "AUTH_ACCOUNTS_ENABLED must be true or false",
    );
    expect(() => loadEnv({ ...config, ORKBOT_BOOTSTRAP_SECRET: "short" })).toThrow(
      "ORKBOT_BOOTSTRAP_SECRET",
    );
  });

  it("defaults the attachment count to four and accepts configured bounds", () => {
    expect(loadEnv(base).maxAttachmentsPerMessage).toBe(4);
    expect(loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: " " }).maxAttachmentsPerMessage).toBe(4);
    for (const count of [1, 8, 100]) {
      expect(
        loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: ` ${count} ` }).maxAttachmentsPerMessage,
      ).toBe(count);
    }
  });
  it.each(["0", "1e2", "101"])("rejects invalid attachment count %s", (value) => {
    expect(() => loadEnv({ ...base, MAX_ATTACHMENTS_PER_MESSAGE: value })).toThrow(
      "MAX_ATTACHMENTS_PER_MESSAGE",
    );
  });

  it("keeps calls off unless explicitly enabled", () => {
    expect(loadEnv(base).phoneCallsEnabled).toBe(false);
    for (const value of ["false", "1", ""]) {
      expect(loadEnv({ ...base, PHONE_CALLS_ENABLED: value }).phoneCallsEnabled).toBe(false);
    }
    expect(loadEnv({ ...base, PHONE_CALLS_ENABLED: "true" }).phoneCallsEnabled).toBe(true);
  });
  it("parses the call ring window and falls back for invalid values", () => {
    expect(loadEnv(base).phoneCallRingSeconds).toBe(45);
    expect(loadEnv({ ...base, PHONE_CALL_RING_SECONDS: "90" }).phoneCallRingSeconds).toBe(90);
    for (const value of ["", "0", "-1", "invalid", "NaN", "Infinity"]) {
      expect(loadEnv({ ...base, PHONE_CALL_RING_SECONDS: value }).phoneCallRingSeconds).toBe(45);
    }
  });

  it("defaults uploads to 10 MiB and parses a configured limit", () => {
    expect(loadEnv(base).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: "" }).maxUploadSizeBytes).toBe(10 * 1024 * 1024);
    expect(loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: " 25 " }).maxUploadSizeBytes).toBe(
      25 * 1024 * 1024,
    );
  });

  it.each(["0", "1e3", "9007199254740991"])("rejects invalid upload limit %s", (value) => {
    expect(() => loadEnv({ ...base, MAX_UPLOAD_SIZE_MB: value })).toThrow("MAX_UPLOAD_SIZE_MB");
  });
  it("keeps the ticket board off unless explicitly enabled", () => {
    expect(loadEnv(base).ticketBoardEnabled).toBe(false);
    for (const value of ["false", "1", ""])
      expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: value }).ticketBoardEnabled).toBe(false);
    expect(loadEnv({ ...base, TICKET_BOARD_ENABLED: "true" }).ticketBoardEnabled).toBe(true);
  });
  it("loads operator menu links and refuses to start on a bad value", () => {
    expect(loadEnv(base).navLinks).toEqual([]);
    expect(
      loadEnv({
        ...base,
        ORKBOT_NAV_LINKS: '[{"id":"clients","label":"Clients","path":"/ext/clients/"}]',
      }).navLinks,
    ).toEqual([{ id: "clients", label: "Clients", path: "/ext/clients/", trusted: false }]);
    expect(() =>
      loadEnv({ ...base, ORKBOT_NAV_LINKS: '[{"id":"x","label":"X","path":"/api/me"}]' }),
    ).toThrow("ORKBOT_NAV_LINKS");
  });
  it("defaults the product path to Pi, Docker, and Graphile Worker", () => {
    const env = loadEnv(base);
    expect(env.agentRuntime).toBe("pi");
    expect(env.sandboxProvider).toBe("docker");
    expect(env.wakeupDriver).toBe("graphile");
    expect(env.apiHost).toBe("127.0.0.1");
    expect(env.nodeEnv).toBe("test");
  });

  it("defaults Pi JSONL session recording to off", () => {
    expect(loadEnv(base).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "false" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "1" }).piSessionRecording).toBe(false);
    expect(loadEnv({ ...base, PI_SESSION_RECORDING: "true" }).piSessionRecording).toBe(true);
  });

  it("keeps explicit emulator settings for pnpm test", () => {
    const env = loadEnv({
      ...base,
      AGENT_RUNTIME: "scripted",
      SANDBOX_PROVIDER: "fake",
      WAKEUP_DRIVER: "memory",
    });
    expect(env.agentRuntime).toBe("scripted");
    expect(env.sandboxProvider).toBe("fake");
    expect(env.wakeupDriver).toBe("memory");
  });

  it("loads an optional integrations catalog mirror", () => {
    expect(loadEnv(base).integrationsCatalogUrl).toBeUndefined();
    expect(
      loadEnv({ ...base, INTEGRATIONS_CATALOG_URL: " https://catalog.example.test/feed " })
        .integrationsCatalogUrl,
    ).toBe("https://catalog.example.test/feed");
  });

  it("falls back to none when a remote provider key is missing", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "e2b",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "createos",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "none",
      }).sandboxProvider,
    ).toBe("none");
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "",
      }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Daytona configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "daytona",
      DAYTONA_API_KEY: "test-daytona-key",
      DAYTONA_API_URL: "https://daytona.test/api",
      DAYTONA_TARGET: "test-target",
    });
    expect(env).toMatchObject({
      sandboxProvider: "daytona",
      daytonaApiKey: "test-daytona-key",
      daytonaApiUrl: "https://daytona.test/api",
      daytonaTarget: "test-target",
    });
  });

  it("loads Novita credentials and the shared sandbox template", () => {
    expect(
      loadEnv({
        ...base,
        SANDBOX_PROVIDER: "novita",
        NOVITA_API_KEY: "test-novita-key",
        SANDBOX_TEMPLATE: "custom-desktop",
      }),
    ).toMatchObject({
      sandboxProvider: "novita",
      novitaApiKey: "test-novita-key",
      sandboxTemplate: "custom-desktop",
    });
    expect(
      loadEnv({ ...base, SANDBOX_PROVIDER: "novita", E2B_API_KEY: "test-e2b-key" }).sandboxProvider,
    ).toBe("none");
  });

  it("loads provider-specific Boat configuration", () => {
    const env = loadEnv({
      ...base,
      SANDBOX_PROVIDER: "boat",
      BOAT_API_KEY: "test-boat-key",
      BOAT_API_URL: "https://boat.test/api/v1",
    });
    expect(env).toMatchObject({
      sandboxProvider: "boat",
      boatApiKey: "test-boat-key",
      boatApiUrl: "https://boat.test/api/v1",
    });
  });

  it("throws when production omits secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when production uses placeholder secrets", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "dev-secret-change-me-please-32chars",
        ENCRYPTION_KEY: "real-encryption-key-value",
        SANDBOX_SUPERVISOR_TOKEN: "real-supervisor-token-with-enough-length",
        SCREEN_PROXY_SECRET: "real-screen-proxy-secret-with-enough-length",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("loads real secrets in production", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
      API_HOST: "0.0.0.0",
    });
    expect(env.authSecret).toBe("prod-auth-secret-with-enough-length");
    expect(env.encryptionKey).toBe("prod-encryption-key-with-enough-length");
    expect(env.sandboxSupervisorToken).toBeUndefined();
    expect(env.screenProxySecret).toBe("prod-screen-proxy-secret-with-enough-length");
    expect(env.apiHost).toBe("0.0.0.0");
  });

  it("encrypts content on servers by default and fails startup on an invalid switch", () => {
    const production = {
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "e2b",
    };
    expect(loadEnv(production).contentEncryption).toBe(true);
    expect(loadEnv({ ...production, CONTENT_ENCRYPTION: "off" }).contentEncryption).toBe(false);
    expect(
      loadEnv({ DATABASE_URL: base.DATABASE_URL, NODE_ENV: "development" }).contentEncryption,
    ).toBe(false);
    expect(() => loadEnv({ ...production, CONTENT_ENCRYPTION: "maybe" })).toThrow(
      /CONTENT_ENCRYPTION must be "on" or "off"/,
    );
  });

  it("falls back to none in production when Docker has no supervisor token", () => {
    const env = loadEnv({
      DATABASE_URL: base.DATABASE_URL,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
      ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
      SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
      SANDBOX_PROVIDER: "docker",
    });
    expect(env.sandboxProvider).toBe("none");
    expect(env.sandboxSupervisorToken).toBeUndefined();
  });

  it("requires a dedicated supervisor token when Docker stays selected", () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: base.DATABASE_URL,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "docker",
        SANDBOX_SUPERVISOR_TOKEN: "too-short",
      }),
    ).toThrow(/SANDBOX_SUPERVISOR_TOKEN/);
  });

  it("exposes a deployed git revision when GIT_SHA is set", () => {
    expect(loadEnv(base).gitSha).toBeUndefined();
    expect(loadEnv({ ...base, GIT_SHA: "  3c6e209  " }).gitSha).toBe("3c6e209");
    expect(loadEnv({ ...base, ORKBOT_GIT_SHA: "abc1234" }).gitSha).toBe("abc1234");
  });

  it("loads per-client minimum builds and refuses a malformed one", () => {
    expect(loadEnv(base).minimumClientBuilds).toEqual({});
    expect(
      loadEnv({ ...base, ORKBOT_MIN_CLIENT_BUILD: "web=20261022093015" }).minimumClientBuilds,
    ).toEqual({ web: "20261022093015" });
    expect(() => loadEnv({ ...base, ORKBOT_MIN_CLIENT_BUILD: "latest" })).toThrow(
      /ORKBOT_MIN_CLIENT_BUILD/,
    );
  });

  it("loads an optional Expo access token", () => {
    expect(loadEnv(base).expoAccessToken).toBeUndefined();
    expect(loadEnv({ ...base, EXPO_ACCESS_TOKEN: " fake-expo-token " }).expoAccessToken).toBe(
      "fake-expo-token",
    );
  });

  it("loads SMTP configuration and keeps the email emulator out of production", () => {
    expect(
      loadEnv({
        ...base,
        SMTP_URL: " smtps://user:secret@smtp.example.test:465 ",
        EMAIL_FROM: " Ork <no-reply@example.test> ",
        EMAIL_EMULATOR: "true",
      }),
    ).toMatchObject({
      smtpUrl: "smtps://user:secret@smtp.example.test:465",
      emailFrom: "Ork <no-reply@example.test>",
      emailEmulator: true,
    });
    expect(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "prod-auth-secret-with-enough-length",
        ENCRYPTION_KEY: "prod-encryption-key-with-enough-length",
        SCREEN_PROXY_SECRET: "prod-screen-proxy-secret-with-enough-length",
        SANDBOX_PROVIDER: "none",
        EMAIL_EMULATOR: "true",
      }).emailEmulator,
    ).toBe(false);
    expect(loadEnv({ ...base, NODE_ENV: "development" }).nodeEnv).toBe("development");
  });

  it("loads generic email API connection settings", () => {
    expect(
      loadEnv({ ...base, EMAIL_PROVIDER: " resend ", EMAIL_API_KEY: " fake-key " }),
    ).toMatchObject({
      emailProvider: "resend",
      emailApiKey: "fake-key",
    });
    expect(loadEnv(base).emailProvider).toBeUndefined();
    expect(loadEnv(base).emailApiKey).toBeUndefined();
  });

  it("defaults the remote MCP private-endpoint escape to off", () => {
    expect(loadEnv(base).mcpAllowPrivateEndpoint).toBe(false);
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "true" }).mcpAllowPrivateEndpoint).toBe(
      true,
    );
    expect(loadEnv({ ...base, MCP_ALLOW_PRIVATE_ENDPOINT: "1" }).mcpAllowPrivateEndpoint).toBe(
      false,
    );
  });
});

describe("OIDC environment", () => {
  const oidc = {
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "fake-client",
    OIDC_CLIENT_SECRET: "fake-secret",
  };
  it("requires issuer and client ID together, and an HTTPS issuer", () => {
    for (const [key, value] of Object.entries(oidc))
      expect(() => loadEnv({ ...base, [key]: value })).toThrow(/configured together/);
    expect(() =>
      loadEnv({ ...base, ...oidc, OIDC_ISSUER: "http://identity.example.test" }),
    ).toThrow(/HTTPS/);
  });
  it("accepts public clients without a secret and preserves confidential client secrets", () => {
    expect(
      loadEnv({ ...base, OIDC_ISSUER: oidc.OIDC_ISSUER, OIDC_CLIENT_ID: oidc.OIDC_CLIENT_ID }).oidc,
    ).toMatchObject({
      issuer: oidc.OIDC_ISSUER,
      clientId: oidc.OIDC_CLIENT_ID,
      clientSecret: undefined,
    });
    expect(loadEnv({ ...base, ...oidc }).oidc?.clientSecret).toBe(oidc.OIDC_CLIENT_SECRET);
    expect(() => loadEnv({ ...base, OIDC_CLIENT_SECRET: oidc.OIDC_CLIENT_SECRET })).toThrow(
      /configured together/,
    );
  });
  it("accepts a loopback callback only on this server's auth origin", () => {
    const configuration = {
      ...base,
      OIDC_ISSUER: oidc.OIDC_ISSUER,
      OIDC_CLIENT_ID: oidc.OIDC_CLIENT_ID,
      BETTER_AUTH_URL: "http://127.0.0.1:45173",
      OIDC_REDIRECT_URI: "http://127.0.0.1:45173/callback",
    };
    expect(loadEnv(configuration).oidc?.redirectURI).toBe(configuration.OIDC_REDIRECT_URI);
    for (const redirectURI of [
      "http://127.0.0.1:45174/callback",
      "http://127.0.0.1:45173/api/auth/callback/oidc",
      "http://127.0.0.1:45173/callback?next=elsewhere",
      "http://127.0.0.1:45173/callback#fragment",
      "http://user:password@127.0.0.1:45173/callback",
      "http://localhost:45173/callback",
      "https://127.0.0.1:45173/callback",
      "https://identity.example.test/callback",
      "not-a-url",
    ]) {
      expect(() => loadEnv({ ...configuration, OIDC_REDIRECT_URI: redirectURI })).toThrow(
        /HTTP loopback \/callback/,
      );
    }
    expect(() => loadEnv({ ...base, OIDC_REDIRECT_URI: configuration.OIDC_REDIRECT_URI })).toThrow(
      /requires OIDC/,
    );
  });
  it.each(["identity.example.test", "/issuer", "https://"])(
    "reports invalid issuer %s as a configuration error",
    (issuer) => {
      expect(() => loadEnv({ ...base, ...oidc, OIDC_ISSUER: issuer })).toThrow(
        "OIDC_ISSUER must be an HTTPS issuer URL",
      );
    },
  );
  it("guards password-only lockout without contacting discovery", () => {
    expect(() => loadEnv({ ...base, AUTH_PASSWORD_ENABLED: "false" })).toThrow(/requires OIDC/);
    expect(loadEnv({ ...base, ...oidc, AUTH_PASSWORD_ENABLED: "false" }).passwordAuth).toBe(false);
  });
  it("leaves the breached password check off unless explicitly enabled", () => {
    expect(loadEnv(base).breachedPasswordCheck).toBe(false);
    expect(
      loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "true" }).breachedPasswordCheck,
    ).toBe(true);
    expect(() => loadEnv({ ...base, AUTH_BREACHED_PASSWORD_CHECK_ENABLED: "yes" })).toThrow(
      "AUTH_BREACHED_PASSWORD_CHECK_ENABLED must be true or false",
    );
  });
  it("defaults to SSO with no policy bypass", () => {
    expect(loadEnv({ ...base, ...oidc }).oidc).toMatchObject({
      name: "SSO",
      allowSignupBypass: false,
      scopes: ["openid", "email", "profile"],
    });
    expect(
      loadEnv({ ...base, ...oidc, OIDC_ALLOW_SIGNUP_BYPASS: "true" }).oidc?.allowSignupBypass,
    ).toBe(true);
  });
});

describe("product API authentication boundary", () => {
  const configured = {
    ...base,
    OIDC_ISSUER: "https://api.ork.run",
    OIDC_CLIENT_ID: "offline-public-client",
  };

  it("accepts a pinned test issuer and refuses a production override", () => {
    const configuration = {
      ...base,
      AUTH_ACCOUNTS_ENABLED: "true",
      ACCOUNTS_ISSUER: "https://accounts.example.test",
    };
    expect(loadProductEnv(configuration).accountsIssuer).toBe(configuration.ACCOUNTS_ISSUER);
    expect(() => loadProductEnv({ ...configuration, NODE_ENV: "production" })).toThrow(
      "ACCOUNTS_ISSUER",
    );
    for (const issuer of [
      "http://accounts.example.test",
      "https://accounts.example.test/path",
      "https://accounts.example.test/",
      "https://user:password@accounts.example.test",
      "https://accounts.example.test?query=1",
    ]) {
      expect(() => loadEnv({ ...base, ACCOUNTS_ISSUER: issuer })).toThrow("ACCOUNTS_ISSUER");
    }
  });

  it("starts native Accounts without a client registration and keeps local auth closed", () => {
    const config = { ...base, AUTH_ACCOUNTS_ENABLED: "true" };
    const env = loadProductEnv(config);
    expect(env.accountsEnabled).toBe(true);
    expect(env.passwordAuth).toBe(false);
    expect(env.oidc).toBeUndefined();
    expect(loadProductEnv({ ...config, OIDC_ISSUER: configured.OIDC_ISSUER }).oidc).toBeUndefined();
    expect(() => loadProductEnv({ ...config, AUTH_PASSWORD_ENABLED: "true" })).toThrow(
      "AUTH_PASSWORD_ENABLED must be false",
    );
    expect(() =>
      loadProductEnv({ ...config, OIDC_ISSUER: "https://different.example.test" }),
    ).toThrow("OIDC_ISSUER must be https://api.ork.run");
  });

  it("requires explicit central issuer and client settings before startup", () => {
    expect(() => loadProductEnv(base)).toThrow("OIDC_ISSUER");
    expect(() => loadProductEnv({ ...configured, OIDC_ISSUER: undefined })).toThrow("OIDC_ISSUER");
    expect(() => loadProductEnv({ ...configured, OIDC_CLIENT_ID: undefined })).toThrow(
      "OIDC_CLIENT_ID",
    );
    expect(() =>
      loadProductEnv({
        ...configured,
        OIDC_CLIENT_ID: undefined,
        OIDC_CLIENT_SECRET: "fake-secret",
      }),
    ).toThrow("OIDC_CLIENT_ID");
  });

  it("uses only central Accounts with every local login disabled by default", () => {
    const env = loadProductEnv(configured);
    expect(env.passwordAuth).toBe(false);
    expect(env.oidc).toMatchObject({
      issuer: "https://api.ork.run",
      clientId: "offline-public-client",
      clientSecret: undefined,
      name: "Ork Accounts",
    });
    expect(loadProductEnv({ ...configured, AUTH_PASSWORD_ENABLED: "false" }).passwordAuth).toBe(
      false,
    );
  });

  it.each(["true", "1", "yes"])("rejects local-auth opt-in %s", (value) => {
    expect(() => loadProductEnv({ ...configured, AUTH_PASSWORD_ENABLED: value })).toThrow(
      "AUTH_PASSWORD_ENABLED must be false",
    );
  });

  it.each([
    "https://identity.example.test",
    "https://api.ork.run/",
    "http://api.orkbot.run",
    "https://api.ork.run?next=other",
    "https://user:password@api.orkbot.run",
    "not-a-url",
  ])("rejects a different or noncanonical issuer %s", (issuer) => {
    expect(() => loadProductEnv({ ...configured, OIDC_ISSUER: issuer })).toThrow(
      "OIDC_ISSUER must be https://api.ork.run",
    );
  });
});

describe("web origin", () => {
  it("drops trailing slashes so links never double up", () => {
    expect(loadEnv({ ...base, WEB_ORIGIN: "https://app.example.com/" }).webOrigin).toBe(
      "https://app.example.com",
    );
    expect(loadEnv({ ...base, WEB_ORIGIN: "https://app.example.com///" }).webOrigin).toBe(
      "https://app.example.com",
    );
    expect(loadEnv({ ...base, WEB_ORIGIN: " https://app.example.com " }).webOrigin).toBe(
      "https://app.example.com",
    );
  });

  it("keeps the local default when none is set", () => {
    expect(loadEnv(base).webOrigin).toBe("http://127.0.0.1:5173");
    expect(loadEnv(base).authUrl).toBe("http://127.0.0.1:5173");
  });

  it.each(["", " \t "])("uses the local default for blank WEB_ORIGIN %j", (value) => {
    const env = loadEnv({ ...base, WEB_ORIGIN: value });
    expect(env.webOrigin).toBe("http://127.0.0.1:5173");
    expect(env.authUrl).toBe("http://127.0.0.1:5173");
  });

  it.each(["", " \t "])("uses webOrigin for blank BETTER_AUTH_URL %j", (value) => {
    const env = loadEnv({
      ...base,
      WEB_ORIGIN: "https://app.example.com/",
      BETTER_AUTH_URL: value,
    });
    expect(env.authUrl).toBe("https://app.example.com");
  });

  it("normalises BETTER_AUTH_URL the same way and keeps a path", () => {
    const env = loadEnv({
      ...base,
      WEB_ORIGIN: "https://app.example.com/",
      BETTER_AUTH_URL: "https://auth.example.com/base/",
    });
    expect(env.authUrl).toBe("https://auth.example.com/base");
    expect(env.webOrigin).toBe("https://app.example.com");
  });

  it("refuses something that is not an absolute URL", () => {
    expect(() => loadEnv({ ...base, WEB_ORIGIN: "app.example.com" })).toThrow(
      "WEB_ORIGIN must be an absolute http(s) URL",
    );
  });

  it("names BETTER_AUTH_URL when it is invalid", () => {
    expect(() => loadEnv({ ...base, BETTER_AUTH_URL: "app.example.com" })).toThrow(
      "BETTER_AUTH_URL must be an absolute http(s) URL",
    );
  });

  it.each(["WEB_ORIGIN", "BETTER_AUTH_URL"])("refuses non-HTTP URLs for %s", (name) => {
    expect(() => loadEnv({ ...base, [name]: "app.example.com:5173" })).toThrow(
      `${name} must be an absolute http(s) URL`,
    );
  });

  it.each(["WEB_ORIGIN", "BETTER_AUTH_URL"])("does not expose invalid %s values", (name) => {
    const value = "postgres://user:password@db.example.test/database";
    const load = () => loadEnv({ ...base, [name]: value });
    expect(load).toThrow(`${name} must be an absolute http(s) URL`);
    expect(load).not.toThrow(value);
  });
});
