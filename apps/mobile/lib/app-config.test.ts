// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Apache-2.0 covers the baseline; changes after the licensing transition are PolyForm-covered.
// Modified by Ork contributors to verify the new share extension's application identifier.

import { readFileSync } from "node:fs";
import type { ConfigContext, ExpoConfig } from "expo/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import appConfig from "../app.config";

beforeEach(() => {
  vi.stubEnv("ORK_ACCOUNTS_ISSUER", undefined);
  vi.stubEnv("ORK_ACCOUNTS_MOBILE_CLIENT_ID", undefined);
  vi.stubEnv("EAS_BUILD_PROFILE", "development");
  vi.stubEnv("EXPO_PUBLIC_API_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const config: ExpoConfig = {
  name: "Example",
  slug: "example",
  android: { package: "com.example.app", permissions: ["POST_NOTIFICATIONS"] },
  ios: { bundleIdentifier: "com.example.app" },
  extra: { example: true },
};

function context(config: ExpoConfig): ConfigContext {
  return { config, projectRoot: "/project", staticConfigPath: null, packageJsonPath: null };
}

const passkeys = {
  ios: { ...config.ios, associatedDomains: ["webcredentials:app.example.com"] },
  extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
};

describe("mobile app config", () => {
  it.each(["production", "android-apk", "diagnostic"])(
    "requires the central public client for %s builds",
    (profile) => {
      vi.stubEnv("EAS_BUILD_PROFILE", profile);
      expect(() => appConfig(context(config))).toThrow(/Accounts issuer/);
      vi.stubEnv("ORK_ACCOUNTS_ISSUER", "https://api.orkbot.run");
      expect(() => appConfig(context(config))).toThrow(/public mobile client ID/);
      vi.stubEnv("ORK_ACCOUNTS_MOBILE_CLIENT_ID", "public-mobile-client");
      expect(appConfig(context(config)).extra).toMatchObject({
        accountsIssuer: "https://api.orkbot.run",
        accountsClientId: "public-mobile-client",
      });
      vi.stubEnv("ORK_ACCOUNTS_ISSUER", "https://other.example.test");
      expect(() => appConfig(context(config))).toThrow(/Accounts issuer/);
    },
  );
  it("keeps the fork detached from an unconfigured Expo project and native stores", () => {
    const manifest = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")).expo;
    expect(manifest.scheme).toEqual(["orkbot", "run.orkbot.app"]);
    expect(manifest.owner).toBeUndefined();
    expect(manifest.extra.eas.projectId).toBeUndefined();
    expect(manifest.updates).toEqual({ enabled: false });
    expect(manifest.ios.bundleIdentifier).toBe("run.orkbot.app");
    expect(manifest.android.package).toBe("run.orkbot.app");
    expect(
      manifest.extra.eas.build.experimental.ios.appExtensions.map(
        (extension: { bundleIdentifier: string }) => extension.bundleIdentifier,
      ),
    ).toEqual([
      "run.orkbot.app.widgets",
      "run.orkbot.app.expo-sharing-extension",
      "run.orkbot.app.notifications",
    ]);
  });
  it("embeds explicit public Accounts build settings without replacing existing extra values", () => {
    vi.stubEnv("ORK_ACCOUNTS_ISSUER", "https://accounts.example.test");
    vi.stubEnv("ORK_ACCOUNTS_MOBILE_CLIENT_ID", "public-mobile-client");
    expect(appConfig(context(config)).extra).toEqual({
      ...config.extra,
      passkeyRpIds: ["app.example.com"],
      accountsIssuer: "https://accounts.example.test",
      accountsClientId: "public-mobile-client",
    });
  });

  it("loads the Firebase file path while preserving the existing config", () => {
    vi.stubEnv("GOOGLE_SERVICES_JSON", "/build/google-services.json");

    expect(appConfig(context(config))).toEqual({
      ...config,
      ...passkeys,
      android: { ...config.android, googleServicesFile: "/build/google-services.json" },
    });
    expect(config.android).not.toHaveProperty("googleServicesFile");
  });

  it("leaves the config unchanged when no variable applies", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("EXPO_PUBLIC_API_URL", undefined);
    vi.stubEnv("GOOGLE_SERVICES_JSON", undefined);
    const existing = {
      ...config,
      android: { ...config.android, googleServicesFile: "./custom-google-services.json" },
    };

    expect(appConfig(context(existing))).toBe(existing);
    expect(appConfig(context(config))).toBe(config);
  });

  it("adds Android config when none exists", () => {
    vi.stubEnv("GOOGLE_SERVICES_JSON", "/build/google-services.json");
    const { android: _android, ...withoutAndroid } = config;

    expect(appConfig(context(withoutAndroid))).toEqual({
      ...withoutAndroid,
      ...passkeys,
      android: { googleServicesFile: "/build/google-services.json" },
    });
  });

  it("associates the default server's domain for passkeys and keeps other domains", () => {
    vi.stubEnv("EXPO_PUBLIC_API_URL", "https://App.Example.com:8443/api");
    const existing = { ...config, ios: { ...config.ios, associatedDomains: ["applinks:x.test"] } };

    expect(appConfig(context(existing))).toEqual({
      ...config,
      ios: {
        ...config.ios,
        associatedDomains: ["applinks:x.test", "webcredentials:app.example.com"],
      },
      extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
    });
  });

  it("asks a development build to fetch the association itself in developer mode", () => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("ORKBOT_PASSKEY_DEVELOPER_MODE", "1");

    expect(appConfig(context(config))).toEqual({
      ...config,
      ios: { ...config.ios, associatedDomains: ["webcredentials:app.example.com?mode=developer"] },
      extra: { ...config.extra, passkeyRpIds: ["app.example.com"] },
    });
  });

  it.each([
    "http://app.example.com",
    "https://localhost:3100",
    "https://192.168.1.20",
    "https://[::1]",
    "not a url",
  ])("skips passkey domains for %s", (url) => {
    vi.stubEnv("EAS_BUILD_PROFILE", "development");
    vi.stubEnv("EXPO_PUBLIC_API_URL", url);
    vi.stubEnv("GOOGLE_SERVICES_JSON", undefined);

    expect(appConfig(context(config))).toBe(config);
  });
});
