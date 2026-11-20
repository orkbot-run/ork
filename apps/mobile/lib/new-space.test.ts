// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSpaceCreation } from "./new-space";

const state = vi.hoisted(() => ({
  apiBase: "https://app.example.test",
  generation: 1,
  selection: 1,
  spaceId: "personal" as string | null,
  rpc: vi.fn(),
  capture: vi.fn(),
  select: vi.fn(),
  managed: null as null | { account: string; target: object },
  createAccount: vi.fn(),
}));

vi.mock("./api", () => ({
  currentApiBase: () => state.apiBase,
  selectedSpaceId: () => state.spaceId,
  captureApiRequestContext: state.capture,
  rpc: state.rpc,
  selectSpace: (spaceId: string) => {
    state.selection += 1;
    return state.select(spaceId);
  },
  spaceSelectionSeq: () => state.selection,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => state.generation }));
vi.mock("./installation-transport", () => ({ installationRevocationScope: () => state.managed }));
vi.mock("./account-servers", () => ({ createAccountWorkspace: state.createAccount }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "00000000-0000-4000-8000-000000000001" }));

const originalContext = {
  apiBase: "https://app.example.test",
  sessionGeneration: 1,
  headers: { authorization: "Bearer synthetic", "x-orkbot-space-id": "personal" },
};
const onboardingOptions = {
  requestContext: {
    ...originalContext,
    headers: { ...originalContext.headers, "x-orkbot-space-id": "clients" },
  },
  skipSpaceAuthRecovery: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.apiBase = originalContext.apiBase;
  state.generation = 1;
  state.selection = 1;
  state.spaceId = "personal";
  state.managed = null;
  state.capture.mockResolvedValue(originalContext);
  state.rpc.mockImplementation(async (procedure: string) =>
    procedure === "spaces/create" ? { id: "clients" } : { id: "ordinary-chief" },
  );
  state.select.mockImplementation(async (spaceId: string) => {
    state.spaceId = spaceId;
    return true;
  });
});

describe("explicit new Space onboarding", () => {
  it("registers a company workspace in Accounts instead of creating a local-only space", async () => {
    state.managed = { account: "owner", target: { workspaceId: "existing" } };
    state.createAccount.mockResolvedValue("central-id");
    expect(await newSpaceCreation()("Clients", () => true)).toBe("directory");
    expect(state.createAccount).toHaveBeenCalledWith(
      "owner",
      state.managed.target,
      "Clients",
      "00000000-0000-4000-8000-000000000001",
      expect.any(Function),
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("continues to create a local space for the Personal organization", async () => {
    state.managed = { account: "owner", target: { workspaceId: "personal" } };
    state.createAccount.mockResolvedValue(null);
    expect(await newSpaceCreation()("Clients", () => true)).toBe("ready");
    expect(state.rpc).toHaveBeenCalledWith(
      "spaces/create",
      { name: "Clients" },
      { requestContext: originalContext },
    );
  });

  it("reuses the same operation if an Accounts creation response is lost", async () => {
    state.managed = { account: "owner", target: { workspaceId: "existing" } };
    state.createAccount
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce("central-id");
    const create = newSpaceCreation();
    await expect(create("Clients", () => true)).rejects.toThrow("timeout");
    await expect(create("Clients", () => true)).resolves.toBe("directory");
    expect(state.createAccount.mock.calls.map((call) => call[3])).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("provisions its bot in the new Space using the creation's server and session before switching", async () => {
    state.rpc.mockImplementation(async (procedure: string) => {
      expect(state.spaceId).toBe("personal");
      expect(state.select).not.toHaveBeenCalled();
      return procedure === "spaces/create" ? { id: "clients" } : { id: "ordinary-chief" };
    });
    expect(await newSpaceCreation()("Clients", () => true)).toBe("ready");
    expect(state.capture).toHaveBeenCalledWith("personal");
    expect(state.rpc.mock.calls).toEqual([
      ["spaces/create", { name: "Clients" }, { requestContext: originalContext }],
      ["onboarding/ensureFirstBot", undefined, onboardingOptions],
    ]);
    expect(state.select).toHaveBeenCalledWith("clients");
  });

  it("retries onboarding in the created Space without creating another Space", async () => {
    const create = newSpaceCreation();
    state.rpc.mockResolvedValueOnce({ id: "clients" });
    state.rpc.mockRejectedValueOnce(new Error("onboarding unavailable"));
    await expect(create("Clients", () => true)).rejects.toThrow("onboarding unavailable");
    expect(state.select).not.toHaveBeenCalled();
    expect(await create("Changed name", () => true)).toBe("ready");
    expect(state.capture).toHaveBeenCalledTimes(1);
    expect(state.rpc.mock.calls.map(([procedure]) => procedure)).toEqual([
      "spaces/create",
      "onboarding/ensureFirstBot",
      "onboarding/ensureFirstBot",
    ]);
    expect(state.rpc).toHaveBeenLastCalledWith(
      "onboarding/ensureFirstBot",
      undefined,
      onboardingOptions,
    );
  });

  it("retains the existing selection-failure outcome after the Space and bot were created", async () => {
    state.select.mockResolvedValue(false);
    expect(await newSpaceCreation()("Clients", () => true)).toBe("selection_failed");
    expect(state.spaceId).toBe("personal");
    expect(state.rpc).toHaveBeenLastCalledWith(
      "onboarding/ensureFirstBot",
      undefined,
      onboardingOptions,
    );
  });

  it.each(["session", "server", "space", "reselection", "closed"])(
    "drops a late creation after its %s changes",
    async (change) => {
      let active = true;
      const create = newSpaceCreation();
      let finish!: (value: { id: string }) => void;
      state.rpc.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = create("Clients", () => active);
      await vi.waitFor(() => expect(state.rpc).toHaveBeenCalledTimes(1));
      if (change === "session") state.generation += 1;
      if (change === "server") state.apiBase = "https://other.example.test";
      if (change === "space") state.spaceId = "other";
      if (change === "reselection") state.selection += 2;
      if (change === "closed") active = false;
      finish({ id: "clients" });
      expect(await pending).toBe("stale");
      expect(state.rpc).toHaveBeenCalledTimes(1);
      expect(state.select).not.toHaveBeenCalled();
    },
  );

  it("does not select the created Space after onboarding finishes in a stale session", async () => {
    state.rpc.mockImplementation(async (procedure: string) => {
      if (procedure === "spaces/create") return { id: "clients" };
      state.generation += 1;
      return { id: "ordinary-chief" };
    });
    expect(await newSpaceCreation()("Clients", () => true)).toBe("stale");
    expect(state.select).not.toHaveBeenCalled();
  });

  it("does not let a retry change accounts or create a second Space", async () => {
    const create = newSpaceCreation();
    state.rpc.mockResolvedValueOnce({ id: "clients" });
    state.rpc.mockRejectedValueOnce(new Error("onboarding unavailable"));
    await expect(create("Clients", () => true)).rejects.toThrow("onboarding unavailable");
    state.generation += 1;
    expect(await create("Clients", () => true)).toBe("stale");
    expect(state.rpc).toHaveBeenCalledTimes(2);
    expect(state.select).not.toHaveBeenCalled();
  });

  it("does not navigate over a newer Space selection", async () => {
    state.select.mockImplementation(async () => {
      state.spaceId = "other";
      return true;
    });
    expect(await newSpaceCreation()("Clients", () => true)).toBe("stale");
  });
});
