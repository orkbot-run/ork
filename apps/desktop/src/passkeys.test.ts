// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to retain the Tauri desktop path.
// Inherited material remains Apache-2.0. New changes follow LICENSE.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PASSKEY_RP_ID, passkeyEntitlements } from "./passkeys.js";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
  identifier: string;
};
const base = readFileSync(path.join(root, "src-tauri/Entitlements.plist"), "utf8");

describe("passkeyEntitlements", () => {
  it("adds the application identifier and webcredentials domain to the base entitlements", () => {
    const plist = passkeyEntitlements(base, "ABCDE12345", config.identifier);
    expect(plist.startsWith(base.slice(0, base.lastIndexOf("</dict>")).trimEnd())).toBe(true);
    expect(plist).toContain(
      "<key>com.apple.application-identifier</key>\n    <string>ABCDE12345.run.orkbot.desktop.preview</string>",
    );
    expect(plist).toContain(
      `<key>com.apple.developer.associated-domains</key>\n    <array>\n      <string>webcredentials:${PASSKEY_RP_ID}</string>\n    </array>\n  </dict>\n</plist>`,
    );
  });

  it("marks a development build that fetches the association itself in developer mode", () => {
    const plist = passkeyEntitlements(base, "ABCDE12345", config.identifier, {
      developerMode: true,
    });
    expect(plist).toContain(`<string>webcredentials:${PASSKEY_RP_ID}?mode=developer</string>`);
    expect(plist).toContain("<key>com.apple.security.get-task-allow</key>\n    <true/>\n  </dict>");
    expect(passkeyEntitlements(base, "ABCDE12345", config.identifier)).not.toContain(
      "get-task-allow",
    );
  });

  it("keeps helpers on the base entitlements", () => {
    expect(base).not.toContain("associated-domains");
    expect(base).not.toContain("application-identifier");
  });

  it("rejects a malformed team or bundle identifier", () => {
    expect(() => passkeyEntitlements(base, "", config.identifier)).toThrow();
    expect(() => passkeyEntitlements(base, "abcde12345", config.identifier)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345</string>", config.identifier)).toThrow();
    expect(() => passkeyEntitlements(base, "ABCDE12345", "dev orkbot")).toThrow();
    const derived = passkeyEntitlements(base, "ABCDE12345", config.identifier);
    expect(() => passkeyEntitlements(derived, "ABCDE12345", config.identifier)).toThrow();
  });
});

describe("self-hosted passkey domain", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(rpId: string) {
    vi.stubEnv("ORKBOT_PASSKEY_RP_ID", rpId);
    vi.resetModules();
    return import("./passkeys.js");
  }

  it("defaults to the hosted server's domain", async () => {
    const passkeys = await load("");
    expect(passkeys.PASSKEY_RP_ID).toBe("app.orkbot.run");
  });

  it("associates the build with ORKBOT_PASSKEY_RP_ID", async () => {
    const passkeys = await load(" OrkBot.Example.org ");
    expect(passkeys.PASSKEY_RP_ID).toBe("orkbot.example.org");
    expect(passkeys.passkeyEntitlements(base, "ABCDE12345", config.identifier)).toContain(
      "<string>webcredentials:orkbot.example.org</string>",
    );
  });

  it.each(["https://orkbot.example.org", "localhost", "192.168.1.20", "orkbot.example.org:8443"])(
    "refuses to sign entitlements for %s",
    async (rpId) => {
      const passkeys = await load(rpId);
      expect(() => passkeys.passkeyEntitlements(base, "ABCDE12345", config.identifier)).toThrow(
        "ORKBOT_PASSKEY_RP_ID",
      );
    },
  );
});
