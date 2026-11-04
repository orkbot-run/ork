#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const ownerPassword = randomBytes(32).toString("hex");
const appPassword = randomBytes(32).toString("hex");
const settings = {
  POSTGRES_USER: "ork",
  POSTGRES_DB: "ork",
  POSTGRES_PASSWORD: ownerPassword,
  POSTGRES_APP_PASSWORD: appPassword,
  DATABASE_URL: `postgres://rakazo_app:${appPassword}@127.0.0.1:5433/ork`,
  DATABASE_MIGRATION_URL: `postgres://ork:${ownerPassword}@127.0.0.1:5433/ork`,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  SANDBOX_SUPERVISOR_TOKEN: randomBytes(32).toString("hex"),
  SCREEN_PROXY_SECRET: randomBytes(32).toString("hex"),
};
const example = readFileSync(new URL(".env.example", root), "utf8");
const env = example.replace(/^([A-Z][A-Z0-9_]*)=.*$/gm, (line, name) =>
  Object.hasOwn(settings, name) ? `${name}=${settings[name]}` : line,
);

try {
  writeFileSync(new URL(".env", root), `${env}\nSANDBOX_CONTROL_VIA_LOOPBACK=true\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log("Created .env with independent local secrets. Start Postgres with pnpm db:up.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Kept the existing .env. No settings or secrets were changed.");
}
