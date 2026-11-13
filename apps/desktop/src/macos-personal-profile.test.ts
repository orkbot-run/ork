// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { generateKeyPairSync, verify } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AppleProfiles, ownEntitlements } from "../scripts/macos-personal-profile.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const env = {
  APPLE_API_KEY: "ABCDE12345",
  APPLE_API_ISSUER: "11111111-1111-1111-1111-111111111111",
  APPLE_API_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};
const certificate = { raw: Buffer.from("isolated-public-certificate") };
const identity = "Developer ID Application: Example (ABCDE12345)";
const valid = () => ({
  teams: ["ABCDE12345"],
  prefixes: ["LEGACY1234"],
  allDevices: true,
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  certificates: [certificate.raw],
  entitlements: {
    "com.apple.application-identifier": "LEGACY1234.run.orkbot.desktop.preview",
    "com.apple.developer.team-identifier": "ABCDE12345",
    "keychain-access-groups": ["LEGACY1234.*"],
  },
});

it("derives only this app's access group from its authorized prefix and preserves required app entitlements", () => {
  expect(
    ownEntitlements(valid(), certificate, identity, {
      "com.apple.security.device.audio-input": true,
    }),
  ).toEqual({
    "com.apple.security.device.audio-input": true,
    "com.apple.application-identifier": "LEGACY1234.run.orkbot.desktop.preview",
    "com.apple.developer.team-identifier": "ABCDE12345",
    "keychain-access-groups": ["LEGACY1234.run.orkbot.desktop.preview"],
  });
});

it.each([
  "team",
  "prefix",
  "expiry",
  "certificate",
  "device-profile",
  "application",
  "group",
  "development",
  "entitlement-team",
])("rejects a profile with the wrong %s before using its keychain claims", (kind) => {
  const profile = valid();
  switch (kind) {
    case "team":
      profile.teams = ["OTHER12345"];
      break;
    case "prefix":
      profile.prefixes = ["*"];
      break;
    case "expiry":
      profile.expiresAt = new Date().toISOString();
      break;
    case "certificate":
      profile.certificates = [Buffer.from("another certificate")];
      break;
    case "device-profile":
      profile.allDevices = false;
      break;
    case "application":
      profile.entitlements["com.apple.application-identifier"] = "LEGACY1234.another-app";
      break;
    case "group":
      profile.entitlements["keychain-access-groups"] = ["OTHER12345.*"];
      break;
    case "development":
      Object.assign(profile.entitlements, { "get-task-allow": true });
      break;
    case "entitlement-team":
      profile.entitlements["com.apple.developer.team-identifier"] = "OTHER12345";
      break;
  }
  expect(() => ownEntitlements(profile, certificate, identity, {})).toThrow("Could not prepare");
});

it("signs short Apple API capabilities and confines them to the fixed HTTPS origin", async () => {
  const network = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  const api = new AppleProfiles(env, network);
  await api.list("/v1/profiles?limit=200");
  const [url, init] = network.mock.calls[0]!;
  expect(String(url)).toBe("https://api.appstoreconnect.apple.com/v1/profiles?limit=200");
  expect(init).toMatchObject({ method: "GET", redirect: "error" });
  const token = new Headers(init?.headers).get("authorization")!.slice(7);
  const [header, payload, signature] = token.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: env.APPLE_API_KEY,
    typ: "JWT",
  });
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
    iss: env.APPLE_API_ISSUER,
    aud: "appstoreconnect-v1",
  });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(claims.exp - claims.iat).toBe(120);
  expect(
    verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  for (const endpoint of [
    "https://foreign.example.test/v1/profiles",
    "http://api.appstoreconnect.apple.com/v1/profiles",
    "https://user@api.appstoreconnect.apple.com/v1/profiles",
    "/unrelated",
  ]) {
    await expect(api.request(endpoint)).rejects.toThrow("Could not prepare");
  }
  expect(network).toHaveBeenCalledOnce();
});

it("rejects foreign pagination and oversized responses without exposing API or response secrets", async () => {
  const network = vi.fn<typeof fetch>(async () =>
    Response.json({ data: [], links: { next: "https://foreign.example.test/v1/profiles" } }),
  );
  await expect(new AppleProfiles(env, network).list("/v1/profiles")).rejects.toThrow(
    "Could not prepare",
  );
  expect(network).toHaveBeenCalledOnce();
  const oversized = vi.fn<typeof fetch>(
    async () =>
      new Response("private-response-secret", {
        headers: { "content-length": String(5 * 1024 * 1024) },
      }),
  );
  await expect(new AppleProfiles(env, oversized).request("/v1/profiles")).rejects.toThrow(
    "Could not prepare",
  );
  const denied = new AppleProfiles(
    env,
    async () => new Response("private-response-secret", { status: 403 }),
  );
  await expect(denied.request("/v1/profiles")).rejects.toThrow("Apple API status 403");
  try {
    await denied.request("/v1/profiles");
  } catch (error) {
    expect(String(error)).not.toContain("private-response-secret");
  }
});

it("reconciles a concurrent or ambiguous creation through a read and never replays the mutation", async () => {
  const existing = { type: "profiles", id: "EXISTING" };
  const network = vi.fn<typeof fetch>(async () => new Response("duplicate", { status: 409 }));
  const lookup = vi.fn(async () => existing);
  expect(
    await new AppleProfiles(env, network).createOrFind("/v1/profiles", { data: {} }, lookup),
  ).toEqual(existing);
  expect(network).toHaveBeenCalledOnce();
  expect(lookup).toHaveBeenCalledOnce();
  const failed = new AppleProfiles(env, async () => {
    throw new Error("private-network-diagnostic");
  });
  await expect(failed.createOrFind("/v1/profiles", {}, async () => undefined)).rejects.toThrow(
    "Could not prepare",
  );
});

it("bounds a streaming Apple response even when its declared size is absent", async () => {
  const canceled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel: canceled,
  });
  const api = new AppleProfiles(env, async () => new Response(body));
  await expect(api.request("/v1/profiles")).rejects.toThrow("Could not prepare");
  expect(canceled).toHaveBeenCalledOnce();
});
