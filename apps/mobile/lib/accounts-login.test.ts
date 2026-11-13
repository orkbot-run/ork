// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";
import { continueWithAccountsServer } from "./accounts-login";
import { AccountsUnavailable } from "./accounts-network";
import { personalDigest } from "./personal-device";
import {
  confirmServerInitialization,
  receiveServerConnect,
  serverInitializationSecret,
} from "./server-connect";

const state = vi.hoisted(() => ({
  origin: "https://server.example.test",
  generation: 1,
  accountVersion: 0,
  workspace: null as null | {
    organizationId: string;
    serverId: string;
    workspaceId: string;
    bindingVersion: number;
    keyFingerprint: string;
  },
  identity: {
    issuer: "https://accounts.example.test",
    subject: "owner",
    accessToken: "central-bearer",
  },
  request: vi.fn(),
  replace: vi.fn(),
  clearSpace: vi.fn(),
  stage: vi.fn(),
  activate: vi.fn(),
  forget: vi.fn(),
  sign: vi.fn(),
  authorize: vi.fn(),
  personalSelection: vi.fn(),
  resume: vi.fn(),
  epoch: 0,
}));
vi.mock("./personal-login", () => ({
  personalLoginSelection: (...args: unknown[]) => state.personalSelection(...args),
  continueWithPersonalServer: (...args: unknown[]) => state.resume(...args),
}));
vi.mock("./personal-device", async (original) => ({
  ...(await original<typeof import("./personal-device")>()),
  stagePersonalDevice: (...args: unknown[]) => state.stage(...args),
  activatePersonalDevice: (...args: unknown[]) => state.activate(...args),
  forgetPersonalDevice: (...args: unknown[]) => state.forget(...args),
  signPersonalDevice: (...args: unknown[]) => state.sign(...args),
  personalCredentialEpoch: () => state.epoch,
}));
vi.mock("./accounts", () => ({
  accountsAuthorization: () => state.authorize(),
  accountsVersion: () => state.accountVersion,
}));
vi.mock("./selected-workspace", () => ({ selectedWorkspace: async () => state.workspace }));
vi.mock("./api", () => ({
  currentApiBase: () => state.origin,
  fetchMobileJson: (...args: unknown[]) => state.request(...args),
  clearSpace: () => state.clearSpace(),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  replaceSessionTokenIfCurrent: (...args: unknown[]) => state.replace(...args),
}));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

beforeEach(() => {
  state.origin = "https://server.example.test";
  state.generation = 1;
  state.accountVersion = 0;
  state.workspace = null;
  state.epoch = 0;
  state.authorize.mockReset().mockImplementation(async () => state.identity);
  state.personalSelection.mockReset().mockResolvedValue(null);
  state.resume.mockReset().mockResolvedValue(true);
  state.stage.mockReset().mockResolvedValue(null);
  state.activate.mockReset().mockResolvedValue(undefined);
  state.forget.mockReset().mockResolvedValue(undefined);
  state.sign.mockReset().mockResolvedValue("device-signature");
  state.identity = {
    issuer: "https://accounts.example.test",
    subject: "owner",
    accessToken: "central-bearer",
  };
  state.replace.mockReset().mockResolvedValue(true);
  state.clearSpace.mockReset().mockResolvedValue(true);
  receiveServerConnect("orkbot://connect?server=https%3A%2F%2Fserver.example.test");
  state.request.mockReset().mockImplementation(async (url: string) => ({
    response: new Response(null, { status: 200 }),
    body: url.endsWith("challenge")
      ? {
          challenge: "c".repeat(43),
          expiresAt: Date.now() / 1000 + 60,
          bootstrapRequired: false,
        }
      : url.endsWith("server-login-grants")
        ? {
            grant: "audience-bound-proof",
            expiresAt: Date.now() / 1000 + 60,
          }
        : { token: "server-session", user: { id: "server-user" } },
  }));
});

it("keeps the central bearer on Accounts and saves only the local server session", async () => {
  expect(await continueWithAccountsServer()).toBe(true);
  expect(state.request.mock.calls.map(([url]) => url)).toEqual([
    `${state.origin}/api/auth/native/challenge`,
    `${state.identity.issuer}/api/server-login-grants`,
    `${state.origin}/api/auth/native/complete`,
  ]);
  for (const [url, request] of state.request.mock.calls) {
    expect(request.headers.authorization).toBe(
      url.startsWith(state.identity.issuer) ? "Bearer central-bearer" : undefined,
    );
    expect(request.headers.origin).toBe(
      url.startsWith(state.identity.issuer) ? undefined : "orkbot://",
    );
    expect(request.redirect).toBe("error");
  }
  expect(state.replace).toHaveBeenCalledWith(1, "server-session", "sign_in");
});

it("logs in to the exact central workspace without forwarding the Accounts bearer to its server", async () => {
  state.workspace = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    serverId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "30000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: "a".repeat(64),
  };
  state.request.mockImplementation(async (url: string) => ({
    response: new Response(null, { status: 200 }),
    body: url.endsWith("challenge")
      ? { version: 2, challenge: "c".repeat(43), expiresAt: Date.now() / 1000 + 60 }
      : url.endsWith("login-grants")
        ? { grant: "workspace-grant", expiresAt: Date.now() / 1000 + 60 }
        : {
            token: "workspace-session",
            user: { id: "local-user" },
            workspaceId: state.workspace!.workspaceId,
            spaceId: "local-space",
          },
  }));
  expect(await continueWithAccountsServer()).toBe(true);
  expect(state.request.mock.calls.map(([url]) => url)).toEqual([
    `${state.origin}/api/auth/native/workspace/challenge`,
    `${state.identity.issuer}/api/identity/v2/login-grants`,
    `${state.origin}/api/auth/native/workspace/complete`,
  ]);
  expect(JSON.parse(state.request.mock.calls[1]![1].body)).toEqual({
    organizationId: state.workspace.organizationId,
    serverId: state.workspace.serverId,
    workspaceId: state.workspace.workspaceId,
    challenge: "c".repeat(43),
  });
  expect(state.request.mock.calls[0]![1].headers.authorization).toBeUndefined();
  expect(state.request.mock.calls[2]![1].headers.authorization).toBeUndefined();
});

function personalResponse(activated = true) {
  state.workspace = {
    organizationId: "10000000-0000-4000-8000-000000000001",
    serverId: "20000000-0000-4000-8000-000000000001",
    workspaceId: "30000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: "a".repeat(64),
  };
  const device = { id: "40000000-0000-4000-8000-000000000001", publicKey: "publicSPKI" };
  const staged = {
    device,
    epoch: 0,
    credential: {
      version: 1,
      account: JSON.stringify([state.identity.issuer, state.identity.subject]),
      origin: state.origin,
      scope: "scope",
      deviceId: device.id,
      target: state.workspace,
    },
  };
  state.stage.mockResolvedValue(staged);
  state.request.mockImplementation(async (url: string) => ({
    response: new Response(null, { status: 200 }),
    body: url.endsWith("challenge")
      ? { version: 2, challenge: "c".repeat(43), expiresAt: Date.now() / 1000 + 60 }
      : url.endsWith("login-grants")
        ? { grant: "workspace-grant", expiresAt: Date.now() / 1000 + 60 }
        : {
            token: "workspace-session",
            user: { id: "local-user" },
            workspaceId: state.workspace!.workspaceId,
            spaceId: "local-space",
            ...(activated
              ? {
                  personalDevice: {
                    id: device.id,
                    target: { ...state.workspace, deviceId: device.id },
                  },
                }
              : {}),
          },
  }));
  return staged;
}
it("uses the activated personal key for renewal without requesting another central grant", async () => {
  const staged = personalResponse();
  state.personalSelection.mockResolvedValue(staged.credential);
  expect(await continueWithAccountsServer()).toBe(true);
  expect(state.resume).toHaveBeenCalledWith(staged.credential, expect.any(Function));
  expect(state.stage).not.toHaveBeenCalled();
  expect(state.request).not.toHaveBeenCalled();
});
it.each(["unavailable", "retired"])(
  "renews personal access when Accounts is %s during in-session reauthentication",
  async (reason) => {
    const staged = personalResponse();
    state.personalSelection.mockResolvedValue(staged.credential);
    if (reason === "unavailable") state.authorize.mockRejectedValue(new AccountsUnavailable());
    else state.authorize.mockResolvedValue(null);
    expect(await continueWithAccountsServer()).toBe(true);
    expect(state.request).not.toHaveBeenCalled();
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.resume).toHaveBeenCalledOnce();
  },
);
it("does not turn a server's personal refusal into automatic reactivation", async () => {
  const staged = personalResponse();
  state.personalSelection.mockResolvedValue(staged.credential);
  state.resume.mockRejectedValue(new Error("Access refused"));
  await expect(continueWithAccountsServer()).rejects.toThrow("Access refused");
  expect(state.stage).not.toHaveBeenCalled();
  expect(state.request).not.toHaveBeenCalled();
});
it("does not use personal fallback after an authoritative Accounts failure", async () => {
  state.authorize.mockRejectedValue(new Error("Accounts refused access"));
  await expect(continueWithAccountsServer()).rejects.toThrow("Accounts refused access");
  expect(state.personalSelection).not.toHaveBeenCalled();
  expect(state.resume).not.toHaveBeenCalled();
});
it.each(["accountVersion", "epoch"] as const)(
  "does not resume a personal key selected before the %s changed",
  async (field) => {
    const staged = personalResponse();
    state.personalSelection.mockImplementation(async () => {
      state[field] += 1;
      return staged.credential;
    });
    await expect(continueWithAccountsServer()).rejects.toThrow("Could not continue");
    expect(state.resume).not.toHaveBeenCalled();
  },
);

it("requests public-key activation and signs the exact grant and workspace challenge", async () => {
  const staged = personalResponse();
  expect(await continueWithAccountsServer()).toBe(true);
  expect(JSON.parse(state.request.mock.calls[1]![1].body).personalDevice).toEqual(staged.device);
  expect(state.sign).toHaveBeenCalledWith(
    staged.credential,
    JSON.stringify([
      "ork-personal-device-activation-v1",
      state.workspace!.serverId,
      1,
      "a".repeat(64),
      state.workspace!.workspaceId,
      staged.device.id,
      "c".repeat(43),
      personalDigest("workspace-grant"),
    ]),
    0,
  );
  expect(JSON.parse(state.request.mock.calls[2]![1].body).deviceSignature).toBe("device-signature");
  expect(state.activate).toHaveBeenCalledOnce();
  expect(state.forget).not.toHaveBeenCalled();
});
it("removes the staged key when the workspace has no personal activation", async () => {
  const staged = personalResponse(false);
  expect(await continueWithAccountsServer()).toBe(true);
  expect(state.activate).not.toHaveBeenCalled();
  expect(state.forget).toHaveBeenCalledWith(staged.credential);
});
it("refuses activation for another installation and removes only the staged key", async () => {
  const staged = personalResponse();
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("complete")) result.body.personalDevice.target.bindingVersion += 1;
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow("Could not continue");
  expect(state.forget).toHaveBeenCalledWith(staged.credential);
  expect(state.activate).not.toHaveBeenCalled();
  expect(state.replace).not.toHaveBeenCalled();
});
it("does not save a session when the account changes during native activation", async () => {
  const staged = personalResponse();
  state.activate.mockImplementation(async () => {
    state.accountVersion += 1;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow("Could not continue");
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.forget).toHaveBeenCalledWith(staged.credential);
});
it("removes the activation when the product session could not be saved", async () => {
  const staged = personalResponse();
  state.replace.mockResolvedValue(false);
  expect(await continueWithAccountsServer()).toBe(false);
  expect(state.forget).toHaveBeenCalledWith(staged.credential);
});

it("rejects an old response after the account changes away and back", async () => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("server-login-grants")) state.accountVersion += 2;
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow("Could not continue");
  expect(state.replace).not.toHaveBeenCalled();
});

it("does not complete sign-in if the central account changes while issuing the proof", async () => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("server-login-grants"))
      state.identity = { ...state.identity, subject: "other" };
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.request).toHaveBeenCalledTimes(2);
  expect(state.replace).not.toHaveBeenCalled();
});

it("does not save a session after switching servers during completion", async () => {
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("complete")) state.origin = "https://other.example.test";
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.replace).not.toHaveBeenCalled();
});

it("requires confirmation of both server and account before releasing a bootstrap secret", async () => {
  const secret = "s".repeat(43);
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${secret}`,
  );
  confirmServerInitialization(
    state.origin,
    JSON.stringify([state.identity.issuer, state.identity.subject]),
  );
  const original = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    return result;
  });
  expect(await continueWithAccountsServer()).toBe(true);
  expect(JSON.parse(state.request.mock.calls[2]![1].body).bootstrapSecret).toBe(secret);
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(state.replace).toHaveBeenCalledTimes(1);
});

it("keeps initialization available after a failed grant request", async () => {
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"s".repeat(43)}`,
  );
  confirmServerInitialization(
    state.origin,
    JSON.stringify([state.identity.issuer, state.identity.subject]),
  );
  const request = state.request.getMockImplementation()!;
  let failed = false;
  state.request.mockImplementation(async (...args: unknown[]) => {
    if (String(args[0]).endsWith("server-login-grants") && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    const result = await request(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    return result;
  });
  await expect(continueWithAccountsServer()).rejects.toThrow();
  expect(await continueWithAccountsServer()).toBe(true);
  const completion = state.request.mock.calls.find(([url]) => String(url).endsWith("complete"));
  expect(JSON.parse(completion![1].body).bootstrapSecret).toBe("s".repeat(43));
  expect(state.replace).toHaveBeenCalledOnce();
});

it("keeps a second attempt out until the session has been saved", async () => {
  let saved: (value: boolean) => void = () => undefined;
  let saving: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    saving = resolve;
  });
  state.replace.mockImplementation(() => {
    saving();
    return new Promise<boolean>((resolve) => {
      saved = resolve;
    });
  });
  const first = continueWithAccountsServer();
  await started;
  expect(await continueWithAccountsServer()).toBe(false);
  saved(true);
  expect(await first).toBe(true);
});

it("preserves a newer initialization link when an older attempt completes", async () => {
  const account = JSON.stringify([state.identity.issuer, state.identity.subject]);
  receiveServerConnect(
    `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"a".repeat(43)}`,
  );
  confirmServerInitialization(state.origin, account);
  const request = state.request.getMockImplementation()!;
  state.request.mockImplementation(async (...args: unknown[]) => {
    const result = await request(...args);
    if (String(args[0]).endsWith("challenge")) result.body.bootstrapRequired = true;
    if (String(args[0]).endsWith("complete")) {
      receiveServerConnect(
        `orkbot://initialize?server=${encodeURIComponent(state.origin)}&secret=${"b".repeat(43)}`,
      );
      confirmServerInitialization(state.origin, account);
    }
    return result;
  });
  expect(await continueWithAccountsServer()).toBe(true);
  expect(serverInitializationSecret(state.origin, account)).toBe("b".repeat(43));
});
vi.mock("./installation-transport", () => ({ selectInstallationTransport: async () => undefined }));
