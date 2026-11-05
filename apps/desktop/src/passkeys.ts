// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to retain the Tauri desktop path.
// Inherited material remains Apache-2.0. New changes follow LICENSE.md.

/**
 * The only relying party a build is associated with (`webcredentials:` entitlement). The app and
 * its entitlements must be built with the same `ORKBOT_PASSKEY_RP_ID` value.
 */
export const PASSKEY_RP_ID =
  process.env.ORKBOT_PASSKEY_RP_ID?.trim().toLowerCase() || "app.orkbot.run";

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Adds the passkey association to the app's base entitlements for a build signed by `teamId`.
 * `developerMode` lets a development build fetch the association itself when Apple's CDN cannot
 * reach the domain; macOS only honors it for an app carrying `get-task-allow`.
 */
export function passkeyEntitlements(
  base: string,
  teamId: string,
  bundleId: string,
  options: { developerMode?: boolean } = {},
): string {
  if (!TEAM_ID.test(teamId))
    throw new Error("Apple Team ID must be 10 uppercase letters or digits");
  if (!BUNDLE_ID.test(bundleId)) throw new Error("Invalid bundle identifier");
  if (!DOMAIN.test(PASSKEY_RP_ID)) throw new Error("ORKBOT_PASSKEY_RP_ID must be a domain name");
  const end = base.lastIndexOf("</dict>");
  if (end === -1 || base.includes("com.apple.developer.associated-domains")) {
    throw new Error("Unexpected base entitlements");
  }
  const entries = [
    "    <!-- System passkeys require the embedded provisioning profile. -->",
    "    <key>com.apple.application-identifier</key>",
    `    <string>${teamId}.${bundleId}</string>`,
    "    <key>com.apple.developer.associated-domains</key>",
    "    <array>",
    `      <string>webcredentials:${PASSKEY_RP_ID}${options.developerMode ? "?mode=developer" : ""}</string>`,
    "    </array>",
  ];
  if (options.developerMode) {
    entries.push("    <key>com.apple.security.get-task-allow</key>", "    <true/>");
  }
  return `${base.slice(0, end).trimEnd()}\n${entries.join("\n")}\n  ${base.slice(end)}`;
}
