// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Modified by Ork contributors for product naming and domain module imports.
// Scoped native-session checks are new PolyForm-covered additions.

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedScreenshotApp } from "./cli/mobile-screenshots-session.js";

const developerUrl = "postgres://owner:fixture@127.0.0.1:5433/developer_fixture";
const disposableUrl = "postgres://test:fixture@127.0.0.1:55432/disposable_fixture";

// The Prisma config loads `.env` files into the process; drop whatever they added.
const keysBefore = new Set(Object.keys(process.env));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const key of Object.keys(process.env)) if (!keysBefore.has(key)) delete process.env[key];
});

describe("managed mobile screenshot session", () => {
  const session = {
    origin: "https://10.0.2.2:8244",
    headers: {
      authorization: "Bearer fixture-scoped-session",
      "x-orkbot-space-id": "fixture-workspace",
      [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL_VERSION),
      origin: "orkbot://",
    },
  };

  it("forwards only the admitted workspace session and drops inherited cookies", async () => {
    const request = vi.fn(async () => Response.json({ json: {} }));
    const app = scopedScreenshotApp({ request }, session);
    await app.request("/rpc/me", {
      method: "POST",
      headers: { cookie: "unrelated-cookie", authorization: "Bearer unrelated-session" },
    });
    expect(request).toHaveBeenCalledOnce();
    const [target, options] = request.mock.calls[0]! as unknown as [string, RequestInit];
    expect(target).toBe(`${session.origin}/rpc/me`);
    const headers = new Headers(options.headers);
    expect(headers.get("authorization")).toBe(session.headers.authorization);
    expect(headers.get("x-orkbot-space-id")).toBe("fixture-workspace");
    expect(headers.has("cookie")).toBe(false);
    expect(options.redirect).toBe("error");
  });

  it.each([
    "https://api.ork.run",
    "http://10.0.2.2:8244",
    "https://user:password@10.0.2.2:8244",
    "https://10.0.2.2:8244/path",
    "https://10.0.2.2:8244/?query=value",
  ])("rejects non-isolated or ambiguous session origins before any request: %s", (origin) => {
    const request = vi.fn();
    expect(() => scopedScreenshotApp({ request }, { ...session, origin })).toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.ork.run/rpc/me",
    "https://10.0.2.2:8246/rpc/me",
    "/api/auth/sign-in/email",
  ])("does not forward the scoped token to a different destination: %s", (target) => {
    const request = vi.fn();
    const app = scopedScreenshotApp({ request }, session);
    expect(() => app.request(target)).toThrow("destination mismatch");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["authorization", "x-orkbot-space-id", CLIENT_PROTOCOL_HEADER])(
    "refuses an incomplete native session without %s",
    (header) => {
      const headers: Record<string, string> = { ...session.headers };
      delete headers[header];
      expect(() => scopedScreenshotApp({ request: vi.fn() }, { ...session, headers })).toThrow(
        "admitted native workspace session",
      );
    },
  );
});

describe("mobile screenshot environment", () => {
  it("points Prisma migrations at DATABASE_URL's database over the root .env", async () => {
    vi.stubEnv("DATABASE_URL", disposableUrl);
    // The Prisma config is imported after the CLI environment is configured, and dotenv
    // never overrides a variable that is already set.
    const { configureEnvironment } = await import("./cli/mobile-screenshots.js");
    configureEnvironment();
    process.env.DATABASE_MIGRATION_URL ??= developerUrl;

    const { default: prismaConfig } = await import("../../db/prisma.config.js");

    expect(prismaConfig.datasource?.url).toBe(disposableUrl);
  });

  it("replaces a migration URL the shell already exported", async () => {
    vi.stubEnv("DATABASE_URL", disposableUrl);
    vi.stubEnv("DATABASE_MIGRATION_URL", developerUrl);
    const { configureEnvironment } = await import("./cli/mobile-screenshots.js");
    configureEnvironment();

    const { default: prismaConfig } = await import("../../db/prisma.config.js");

    expect(prismaConfig.datasource?.url).toBe(disposableUrl);
  });
});
