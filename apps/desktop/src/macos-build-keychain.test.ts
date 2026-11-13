// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { configuredPersonalIdentity, signingKeychain } from "../scripts/macos-build-keychain.js";

const env = {
  APPLE_CERTIFICATE: Buffer.from("fixture certificate archive").toString("base64"),
  APPLE_CERTIFICATE_PASSWORD: "fixture-password",
};

it("imports only into its own temporary keychain and preserves keychains added during the build", () => {
  let current = ["/private/login.keychain-db"];
  let owned = "";
  const run = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "create-keychain") owned = args.at(-1)!;
    if (args[0] === "import") current.push("/private/during-import.keychain-db");
    if (args[0] === "list-keychains") {
      if (args[3] === "-s") current = args.slice(4);
      else return current.map((value) => JSON.stringify(value)).join("\n");
    }
    return "";
  });
  const cleanup = signingKeychain(env, run)!;
  expect(current).toEqual([
    owned,
    "/private/login.keychain-db",
    "/private/during-import.keychain-db",
  ]);
  expect(existsSync(path.join(path.dirname(owned), "identity.p12"))).toBe(false);
  current.push("/private/later.keychain-db");
  cleanup();
  expect(current).toEqual([
    "/private/login.keychain-db",
    "/private/during-import.keychain-db",
    "/private/later.keychain-db",
  ]);
  expect(run.mock.calls.filter(([, args]) => args[0] === "delete-keychain")).toEqual([
    ["/usr/bin/security", ["delete-keychain", owned]],
  ]);
  expect(existsSync(path.dirname(owned))).toBe(false);
  cleanup();
  expect(run.mock.calls.filter(([, args]) => args[0] === "delete-keychain")).toHaveLength(1);
});

it("cleans up a partially imported identity and never changes the default keychain", () => {
  let owned = "";
  const run = vi.fn((_command: string, args: string[]) => {
    if (args[0] === "list-keychains" && args.length === 3) return '"/private/login.keychain-db"';
    if (args[0] === "create-keychain") owned = args.at(-1)!;
    if (args[0] === "import") throw new Error("fixture import failure");
    return "";
  });
  expect(() => signingKeychain(env, run)).toThrow("fixture import failure");
  expect(
    run.mock.calls.some(([, args]) => args[0] === "delete-keychain" && args[1] === owned),
  ).toBe(true);
  expect(run.mock.calls.some(([, args]) => args[0] === "default-keychain")).toBe(false);
  expect(existsSync(path.dirname(owned))).toBe(false);
  const unused = vi.fn();
  expect(signingKeychain({}, unused)).toBeUndefined();
  expect(unused).not.toHaveBeenCalled();
});

it("rejects malformed keychain metadata before creating or importing a signing identity", () => {
  const run = vi.fn(() => "unquoted-private-keychain-path");
  expect(() => signingKeychain(env, run)).toThrow("Could not read the macOS keychain list");
  expect(run).toHaveBeenCalledOnce();
});

it("loads only an explicitly requested profile overlay and keeps profile and entitlements paired", () => {
  expect(configuredPersonalIdentity([], "/fixture")).toBeUndefined();
  const args = [
    "--config",
    JSON.stringify({ bundle: { macOS: { entitlements: "/private/main.plist" } } }),
    "--config",
    JSON.stringify({
      bundle: { macOS: { files: { "embedded.provisionprofile": "/private/profile" } } },
    }),
  ];
  expect(configuredPersonalIdentity(args, "/fixture")).toEqual({
    profile: "/private/profile",
    entitlements: "/private/main.plist",
  });
  expect(() =>
    configuredPersonalIdentity(
      [
        "--config",
        JSON.stringify({
          bundle: { macOS: { files: { "embedded.provisionprofile": "/private/profile" } } },
        }),
      ],
      "/fixture",
    ),
  ).toThrow("Incomplete macOS keychain signing configuration");
});
