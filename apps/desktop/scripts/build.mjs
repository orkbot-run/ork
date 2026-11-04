import { createPublicKey } from "node:crypto";
import { build } from "esbuild";

const updatePublicKey = process.env.ORKBOT_LINUX_UPDATE_PUBLIC_KEY?.trim() ?? "";
if (updatePublicKey) {
  if (
    !updatePublicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
    createPublicKey(updatePublicKey).asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("ORKBOT_LINUX_UPDATE_PUBLIC_KEY must be an Ed25519 public key in PEM format.");
  }
}

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron"],
  // Only the release workflow's builds report errors; local and agent builds never do.
  define: {
    "process.env.ORKBOT_ENABLE_AUTO_UPDATE": JSON.stringify(
      process.env.ORKBOT_ENABLE_AUTO_UPDATE ?? "",
    ),
    "process.env.ORKBOT_LINUX_UPDATE_PUBLIC_KEY": JSON.stringify(updatePublicKey),
    "process.env.ORKBOT_DESKTOP_RELEASE": JSON.stringify(process.env.ORKBOT_DESKTOP_RELEASE ?? ""),
    // Self-hosted builds associated with their own passkey domain (see src/passkeys.ts).
    "process.env.ORKBOT_PASSKEY_RP_ID": JSON.stringify(process.env.ORKBOT_PASSKEY_RP_ID ?? ""),
  },
});
