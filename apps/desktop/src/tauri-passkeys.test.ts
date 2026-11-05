// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTauri,
  passkeyBundleConfig,
  validatePasskeyProfile,
} from "../scripts/build-tauri-passkeys.js";
import { PASSKEY_RP_ID, passkeyEntitlements } from "./passkeys.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const bundle = "run.orkbot.desktop.preview";
const profile = () => ({
  team: ["ABCDE12345"],
  expires: "2099-01-01T00:00:00Z",
  entitlements: {
    "com.apple.application-identifier": `ABCDE12345.${bundle}`,
    "com.apple.developer.associated-domains": ["*"],
  } as Record<string, unknown>,
});

beforeEach(() => {
  vi.stubEnv("npm_execpath", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Tauri passkey signing", () => {
  it("authorizes the Preview app with the matching profile", () => {
    expect(validatePasskeyProfile(profile(), bundle, "app.example.com", false)).toBe("ABCDE12345");
  });

  it("refuses missing, expired, or mismatched profile metadata", () => {
    for (const data of [
      { ...profile(), team: [] },
      { ...profile(), team: ["bad"] },
      { ...profile(), expires: "invalid" },
      { ...profile(), expires: "2000-01-01T00:00:00Z" },
      { ...profile(), entitlements: {} },
      {
        ...profile(),
        entitlements: {
          ...profile().entitlements,
          "com.apple.application-identifier": "ABCDE12345.run.orkbot.desktop",
        },
      },
      {
        ...profile(),
        entitlements: {
          ...profile().entitlements,
          "com.apple.developer.associated-domains": ["webcredentials:other.example.com"],
        },
      },
    ]) {
      expect(() => validatePasskeyProfile(data, bundle, "app.example.com", false)).toThrow();
    }
  });

  it("requires a development profile for developer mode", () => {
    const data = profile();
    expect(() => validatePasskeyProfile(data, bundle, "app.example.com", true)).toThrow(
      "development",
    );
    data.entitlements["com.apple.security.get-task-allow"] = true;
    expect(validatePasskeyProfile(data, bundle, "app.example.com", true)).toBe("ABCDE12345");
    data.entitlements["com.apple.developer.associated-domains"] = [
      "webcredentials:app.example.com?mode=developer",
    ];
    expect(validatePasskeyProfile(data, bundle, "app.example.com", true)).toBe("ABCDE12345");
    expect(() => validatePasskeyProfile(data, bundle, "app.example.com", false)).toThrow("domain");
  });

  it("adds associations only to the main app and places the profile in Contents", () => {
    const base = readFileSync(
      path.join(import.meta.dirname, "../src-tauri/Entitlements.plist"),
      "utf8",
    );
    expect(base).not.toContain("associated-domains");
    expect(base).not.toContain("application-identifier");
    const entitlements = passkeyEntitlements(base, "ABCDE12345", bundle);
    expect(entitlements).toContain(`ABCDE12345.${bundle}`);
    expect(entitlements).toContain(`webcredentials:${PASSKEY_RP_ID}`);
    expect(
      passkeyBundleConfig("/build/Entitlements.plist", "/build/profile", "/build/helper"),
    ).toEqual({
      build: { beforeBuildCommand: "" },
      bundle: {
        externalBin: [],
        macOS: {
          entitlements: "/build/Entitlements.plist",
          files: {
            "embedded.provisionprofile": "/build/profile",
            "MacOS/orkbot-speech": "/build/helper",
          },
        },
      },
    });
  });

  it("rejects malformed relying party domains using the shared entitlement generator", async () => {
    for (const rp of [
      "https://app.example.com",
      "localhost",
      "127.0.0.1",
      "app.example.com:443",
      "*.example.com",
      "app.example.com</string>",
    ]) {
      vi.stubEnv("ORKBOT_PASSKEY_RP_ID", rp);
      vi.resetModules();
      const passkeys = await import("./passkeys.js");
      expect(() => passkeys.passkeyEntitlements("<dict></dict>", "ABCDE12345", bundle)).toThrow(
        "ORKBOT_PASSKEY_RP_ID",
      );
    }
  });

  it.runIf(process.platform === "darwin")(
    "passes signing metadata before the CLI and never reuses it for default builds",
    () => {
      vi.stubEnv("PASSKEY_PROFILE", "/private/profile.provisionprofile");
      vi.stubEnv("APPLE_SIGNING_IDENTITY", "Apple Development");
      vi.stubEnv("ORKBOT_PASSKEY_DEVELOPER_MODE", "");
      vi.mocked(spawnSync).mockImplementation(((command: string, args: string[]) => {
        let stdout = "";
        if (command === "/usr/bin/security") stdout = "decoded-profile";
        if (command === "/usr/bin/plutil") {
          stdout =
            args[1] === "TeamIdentifier"
              ? JSON.stringify(profile().team)
              : args[1] === "ExpirationDate"
                ? profile().expires
                : JSON.stringify(profile().entitlements);
        }
        return { status: 0, stdout, stderr: "" };
      }) as typeof spawnSync);
      buildTauri(["--bundles", "app"]);
      const cli = vi.mocked(spawnSync).mock.calls.at(-1)!;
      expect(cli[0]).toBe("pnpm");
      const args = cli[1] as string[];
      expect(args.slice(0, 5)).toEqual(["exec", "tauri", "build", "--bundles", "app"]);
      const config = JSON.parse(args[6]!);
      expect(config.bundle.macOS.entitlements).toMatch(/tauri-passkeys\/Entitlements.plist$/);
      expect(config.bundle.macOS.files["embedded.provisionprofile"]).toMatch(
        /tauri-passkeys\/embedded.provisionprofile$/,
      );
      expect(copyFileSync).toHaveBeenCalledTimes(2);
      expect(config.bundle.externalBin).toEqual([]);
      expect(config.build.beforeBuildCommand).toBe("");
      expect(config.bundle.macOS.files["MacOS/orkbot-speech"]).toMatch(
        /tauri-passkeys\/orkbot-speech$/,
      );
      const helperSign = vi
        .mocked(spawnSync)
        .mock.calls.find(
          ([command, args]) =>
            command === "/usr/bin/codesign" && (args as string[]).includes("--sign"),
        );
      expect(helperSign?.[1]).toEqual(
        expect.arrayContaining([
          "--entitlements",
          expect.stringMatching(/src-tauri\/Entitlements.plist$/),
        ]),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(`webcredentials:${PASSKEY_RP_ID}`),
        expect.any(Object),
      );
      vi.stubEnv("PASSKEY_PROFILE", "");
      buildTauri([]);
      expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[1]).toEqual(["exec", "tauri", "build"]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "refuses a configured passkey build without signing",
    () => {
      vi.stubEnv("PASSKEY_PROFILE", "/private/profile.provisionprofile");
      for (const identity of ["", "-"]) {
        vi.stubEnv("APPLE_SIGNING_IDENTITY", identity);
        expect(() => buildTauri([])).toThrow("signing identity");
      }
      vi.stubEnv("APPLE_SIGNING_IDENTITY", "Apple Development");
      expect(() => buildTauri(["--no-sign"])).toThrow("signing identity");
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );
});
