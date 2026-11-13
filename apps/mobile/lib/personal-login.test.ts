// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { personalOfflineMessage, personalServerMessage } from "@orkbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { continueWithPersonalServer, personalLoginSelection } from "./personal-login";

const state = vi.hoisted(() => ({
  origin: "https://server.example.test",
  generation: 1,
  account: 0,
  epoch: 0,
  request: vi.fn(),
  replace: vi.fn(),
  clear: vi.fn(),
  sign: vi.fn(),
  verify: vi.fn(),
  credential: vi.fn(),
  snapshot: vi.fn(),
  localIdentity: vi.fn(),
}));
vi.mock("./accounts", () => ({
  accountsVersion: () => state.account,
  accountsConfiguration: async () => ({ issuer: "https://accounts.example.test" }),
  accountsLocalIdentity: () => state.localIdentity(),
}));
vi.mock("./api", () => ({
  currentApiBase: () => state.origin,
  fetchMobileJson: (...args: unknown[]) => state.request(...args),
  clearSpace: () => state.clear(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  replaceSessionTokenIfCurrent: (...args: unknown[]) => state.replace(...args),
}));
vi.mock("./selected-workspace", () => ({ selectedWorkspaceSnapshot: () => state.snapshot() }));
vi.mock("./personal-device", () => ({
  personalCredentialEpoch: () => state.epoch,
  personalCredential: (...args: unknown[]) => state.credential(...args),
  signPersonalDevice: (...args: unknown[]) => state.sign(...args),
  verifyPersonalServer: (...args: unknown[]) => state.verify(...args),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const installation = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const device = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKey = installation.publicKey.export({ type: "spki", format: "der" });
const credential = {
  version: 1 as const,
  account: JSON.stringify(["https://accounts.example.test", "owner"]),
  origin: "https://server.example.test",
  scope: "public-scope",
  deviceId: id(4),
  target: {
    organizationId: id(1),
    serverId: id(2),
    workspaceId: id(3),
    bindingVersion: 1,
    keyFingerprint: createHash("sha256").update(publicKey).digest("hex"),
  },
};
const target = {
  serverId: id(2),
  workspaceId: id(3),
  bindingVersion: 1,
  keyFingerprint: credential.target.keyFingerprint,
  deviceId: id(4),
};
const nonce = Buffer.alloc(32, 7).toString("base64url");
function challenge() {
  return {
    version: 1,
    challenge: nonce,
    expiresAt: Date.now() / 1000 + 120,
    target,
    publicKey: publicKey.toString("base64url"),
    signature: sign(
      "sha256",
      Buffer.from(personalServerMessage(target, nonce)),
      installation.privateKey,
    ).toString("base64url"),
  };
}
beforeEach(() => {
  state.origin = credential.origin;
  state.generation = 1;
  state.account = 0;
  state.epoch = 0;
  state.replace.mockReset().mockResolvedValue(true);
  state.clear.mockReset().mockResolvedValue(true);
  state.snapshot.mockReset().mockResolvedValue({
    account: credential.account,
    server: credential.origin,
    target: credential.target,
  });
  state.credential.mockReset().mockResolvedValue(credential);
  state.localIdentity
    .mockReset()
    .mockResolvedValue({ issuer: "https://accounts.example.test", subject: "owner" });
  state.verify
    .mockReset()
    .mockImplementation(
      async (_credential, key, message, signature) =>
        key === publicKey.toString("base64url") &&
        verify(
          "sha256",
          Buffer.from(message),
          installation.publicKey,
          Buffer.from(signature, "base64url"),
        ),
    );
  state.sign
    .mockReset()
    .mockImplementation(async (_credential, message) =>
      sign("sha256", Buffer.from(message), device.privateKey).toString("base64url"),
    );
  state.request.mockReset().mockImplementation(async (url: string) => ({
    response: new Response(null, { status: 200 }),
    body: url.endsWith("challenge")
      ? challenge()
      : {
          token: "personal-session",
          user: { id: "local-user" },
          workspaceId: target.workspaceId,
          spaceId: "local-space",
        },
  }));
});
it("renews the selected personal session with a pinned server proof and no Accounts request or bearer", async () => {
  expect(await continueWithPersonalServer(credential, () => true)).toBe(true);
  expect(state.request.mock.calls.map(([url]) => url)).toEqual([
    `${credential.origin}/api/auth/native/workspace/personal/challenge`,
    `${credential.origin}/api/auth/native/workspace/personal/complete`,
  ]);
  const body = JSON.parse(state.request.mock.calls[1]![1].body);
  expect(body).toMatchObject({ deviceId: credential.deviceId, challenge: nonce });
  expect(
    verify(
      "sha256",
      Buffer.from(personalOfflineMessage(target, nonce)),
      device.publicKey,
      Buffer.from(body.signature, "base64url"),
    ),
  ).toBe(true);
  for (const [, init] of state.request.mock.calls) {
    expect(init.headers.authorization).toBeUndefined();
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
  }
  expect(state.replace).toHaveBeenCalledWith(1, "personal-session", "sign_in");
});
it.each(["serverId", "workspaceId", "bindingVersion", "keyFingerprint", "deviceId"])(
  "refuses a substituted %s before signing",
  async (field) => {
    state.request.mockResolvedValue({
      response: new Response(null, { status: 200 }),
      body: {
        ...challenge(),
        target: { ...target, [field]: field === "bindingVersion" ? 2 : "substituted" },
      },
    });
    await expect(continueWithPersonalServer(credential, () => true)).rejects.toThrow();
    expect(state.sign).not.toHaveBeenCalled();
    expect(state.replace).not.toHaveBeenCalled();
  },
);
it("refuses an invalid installation signature before revealing a device proof", async () => {
  const proof = challenge();
  proof.signature = sign(
    "sha256",
    Buffer.from("different challenge"),
    installation.privateKey,
  ).toString("base64url");
  state.request.mockResolvedValue({ response: new Response(null, { status: 200 }), body: proof });
  await expect(continueWithPersonalServer(credential, () => true)).rejects.toThrow();
  expect(state.sign).not.toHaveBeenCalled();
});
it.each([401, 403, 410, 426])(
  "refuses server HTTP %s without a cached session fallback",
  async (status) => {
    state.request.mockResolvedValue({ response: new Response(null, { status }), body: {} });
    await expect(continueWithPersonalServer(credential, () => true)).rejects.toThrow();
    expect(state.request).toHaveBeenCalledOnce();
    expect(state.replace).not.toHaveBeenCalled();
  },
);
it.each(["account", "generation", "epoch"] as const)(
  "discards a late result after the %s changes",
  async (field) => {
    const original = state.request.getMockImplementation()!;
    state.request.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      if (String(args[0]).endsWith("complete")) state[field] += 1;
      return result;
    });
    await expect(continueWithPersonalServer(credential, () => true)).rejects.toThrow();
    expect(state.replace).not.toHaveBeenCalled();
  },
);
it("does not sign for a different current origin or unavailable selection", async () => {
  state.origin = "https://other.example.test";
  await expect(continueWithPersonalServer(credential, () => true)).rejects.toThrow();
  expect(state.request).not.toHaveBeenCalled();
  state.snapshot.mockResolvedValue(null);
  expect(await personalLoginSelection()).toBeNull();
});
it("selects only the last workspace of the expected account and configured issuer", async () => {
  expect(await personalLoginSelection(credential.account)).toEqual(credential);
  expect(await personalLoginSelection("another-account")).toBeNull();
  state.credential.mockResolvedValue({
    ...credential,
    account: JSON.stringify(["https://other.example.test", "owner"]),
  });
  expect(await personalLoginSelection()).toBeNull();
});
it("refuses a previous account's credential after the verified identity changes or is cleared", async () => {
  state.localIdentity.mockResolvedValue({
    issuer: "https://accounts.example.test",
    subject: "another-owner",
  });
  expect(await personalLoginSelection()).toBeNull();
  state.localIdentity.mockResolvedValue(null);
  expect(await personalLoginSelection()).toBeNull();
  expect(state.credential).not.toHaveBeenCalled();
});
vi.mock("./installation-transport", () => ({ selectInstallationTransport: async () => undefined }));
