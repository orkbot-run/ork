// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  APPLE_RELEASE_SECRETS,
  validateAppleSigning,
  verifyMacApp,
  verifyMacDistribution,
  verifyMacPersonalKey,
} from "../scripts/macos-distribution.js";

const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
  APPLE_CERTIFICATE: "fixture-p12",
  APPLE_CERTIFICATE_PASSWORD: "fixture-password",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
  APPLE_API_ISSUER: "11111111-1111-1111-1111-111111111111",
  APPLE_API_KEY: "ABCDE12345",
  APPLE_API_PRIVATE_KEY: privateKey,
  APPLE_API_KEY_PATH: "/private/fixture-key.p8",
};

it("fails closed with secret names only when Apple distribution credentials are missing", () => {
  for (const name of APPLE_RELEASE_SECRETS)
    expect(() => validateAppleSigning({ ...env, [name]: "" })).toThrow(name);
  expect(() => validateAppleSigning({ ...env, APPLE_SIGNING_IDENTITY: "-" })).toThrow(
    "Invalid macOS",
  );
  expect(() => validateAppleSigning({ ...env, APPLE_API_PRIVATE_KEY: "invalid-secret" })).toThrow(
    "Invalid Apple notarization private key.",
  );
  expect(() => validateAppleSigning(env)).not.toThrow();
});

it("requires the full bundle signature, notarization ticket and Gatekeeper assessment", () => {
  const run = vi.fn((command: string) =>
    command === "/usr/bin/plutil" ? "orkbot-desktop-preview" : "",
  );
  verifyMacApp("/fixture/Ork.app", run);
  expect(run.mock.calls.map((call) => call)).toEqual([
    ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "/fixture/Ork.app"]],
    ["/usr/bin/xcrun", ["stapler", "validate", "/fixture/Ork.app"]],
    ["/usr/sbin/spctl", ["--assess", "--type", "execute", "/fixture/Ork.app"]],
    ["/bin/test", ["-f", "/fixture/Ork.app/Contents/embedded.provisionprofile"]],
    [
      "/usr/bin/plutil",
      ["-extract", "CFBundleExecutable", "raw", "-o", "-", "/fixture/Ork.app/Contents/Info.plist"],
    ],
    ["/fixture/Ork.app/Contents/MacOS/orkbot-desktop-preview", ["--personal-device-key-check"]],
  ]);
  expect(() =>
    verifyMacApp("/fixture/Ork.app", () => {
      throw new Error("invalid signature");
    }),
  ).toThrow("invalid signature");
});

it("checks the update archive and notarizes the installer before accepting distribution", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-macos-distribution-test-"));
  try {
    mkdirSync(path.join(root, "macos/Ork.app"), { recursive: true });
    mkdirSync(path.join(root, "dmg"));
    writeFileSync(path.join(root, "macos/Ork.app.tar.gz"), "fixture");
    writeFileSync(path.join(root, "dmg/Ork.dmg"), "fixture");
    const run = vi.fn((command: string, args: string[]) =>
      args[0] === "notarytool"
        ? JSON.stringify({ status: "Accepted" })
        : command === "/usr/bin/plutil"
          ? "orkbot-desktop-preview"
          : "",
    );
    verifyMacDistribution(root, env, run);
    expect(run.mock.calls.some(([command]) => command === "/usr/bin/tar")).toBe(true);
    expect(run.mock.calls.filter(([command]) => command === "/usr/bin/codesign")).toHaveLength(2);
    expect(run.mock.calls.at(-1)).toEqual([
      "/usr/sbin/spctl",
      [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        path.join(root, "dmg/Ork.dmg"),
      ],
    ]);
    expect(() =>
      verifyMacDistribution(root, env, (command, args) =>
        args[0] === "notarytool"
          ? JSON.stringify({ status: "Invalid" })
          : command === "/usr/bin/plutil"
            ? "orkbot-desktop-preview"
            : "",
      ),
    ).toThrow("Apple did not accept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("requires the embedded profile and a confined executable before running the OS key check", () => {
  for (const executable of ["", "../foreign", "/foreign", ".", "..", "a/b"]) {
    const run = vi.fn((command: string) => (command === "/usr/bin/plutil" ? executable : ""));
    expect(() => verifyMacPersonalKey("/fixture/Ork.app", run)).toThrow(
      "Invalid macOS application executable",
    );
    expect(run).toHaveBeenCalledTimes(2);
  }
  expect(() =>
    verifyMacPersonalKey("/fixture/Ork.app", () => {
      throw new Error("missing profile");
    }),
  ).toThrow("missing profile");
});
