// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Actor } from "@orkbot/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncPrimaryOrk } from "#modules/accounts/first-ork";
import type { RouterDeps } from "../router.js";
import { loadMeDto, meDto } from "./shared.js";

vi.mock("#modules/accounts/first-ork", () => ({ syncPrimaryOrk: vi.fn() }));
vi.mock("#modules/computers/computer-capabilities", () => ({
  computerCapabilities: vi.fn(async () => ({
    start: false,
    screen: false,
    control: false,
    terminal: false,
  })),
}));
vi.mock("#modules/computers/computer-provider-config", () => ({
  effectiveSandboxProvider: () => "docker",
  getAccountComputerSettings: vi.fn(async () => ({ providers: [] })),
}));
vi.mock("@orkbot/adapters", async (original) => ({
  ...(await original<typeof import("@orkbot/adapters")>()),
  findWorkspaceModelPolicy: vi.fn(async () => null),
  resolveMemberMainModel: vi.fn(async () => null),
}));

const actor = { userId: "user", spaceId: "space" } as Actor;
const profile = { email: "ork@example.com", name: "Ork", orkAvatar: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function deps(modelReady: Promise<null>) {
  return {
    prisma: {
      user: { findUniqueOrThrow: vi.fn(async () => profile) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    },
    serverAIModels: { actor: vi.fn(() => modelReady) },
    env: {
      webOrigin: "http://localhost:3000",
      defaultProvider: "anthropic",
      defaultModel: "test-model",
      agentRuntime: "scripted",
    },
  } as unknown as RouterDeps;
}

beforeEach(() => {
  vi.mocked(syncPrimaryOrk).mockReset();
});

describe("bootstrap identity loading", () => {
  it("releases the roster after profile synchronization while model setup is still pending", async () => {
    const sync = deferred<void>();
    const model = deferred<null>();
    vi.mocked(syncPrimaryOrk).mockReturnValue(sync.promise);
    const identity = loadMeDto(deps(model.promise), actor);
    let profileFinished = false;
    let meFinished = false;
    void identity.profileReady.then(() => {
      profileFinished = true;
    });
    void identity.me.then(() => {
      meFinished = true;
    });
    await vi.waitFor(() =>
      expect(syncPrimaryOrk).toHaveBeenCalledWith(expect.anything(), actor, null),
    );
    expect(profileFinished).toBe(false);
    sync.resolve();
    expect(await identity.profileReady).toEqual(profile);
    expect(profileFinished).toBe(true);
    expect(meFinished).toBe(false);
    model.resolve(null);
    expect(await identity.me).toMatchObject({
      userId: "user",
      spaceId: "space",
      email: profile.email,
    });
  });

  it("propagates profile synchronization failures to both bootstrap branches", async () => {
    const failure = new Error("profile synchronization failed");
    vi.mocked(syncPrimaryOrk).mockRejectedValue(failure);
    const identity = loadMeDto(deps(Promise.resolve(null)), actor);
    const results = await Promise.allSettled([identity.profileReady, identity.me]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });

  it("keeps ordinary profile reads synchronized", async () => {
    vi.mocked(syncPrimaryOrk).mockResolvedValue();
    expect(await meDto(deps(Promise.resolve(null)), actor)).toMatchObject({ spaceId: "space" });
    expect(syncPrimaryOrk).toHaveBeenCalledOnce();
  });
});
