// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { beforeEach, expect, it, vi } from "vitest";
import {
  clearWorkspaceDraftSession,
  hydrateWorkspaceDraftSession,
  workspaceDraftOwner,
} from "./workspace-draft-session";

const state = vi.hoisted(() => ({
  identity: { account: "central-owner-a", epoch: "browser-login-a" },
  selected: {
    account: "central-owner-a",
    target: {
      organizationId: "organization-a",
      serverId: "server-a",
      workspaceId: "workspace-a",
      bindingVersion: 1,
      keyFingerprint: "a".repeat(64),
    },
  },
  identityRead: vi.fn(),
}));
vi.mock("./accounts", () => ({ accountsDraftSession: () => state.identityRead() }));
vi.mock("./installation-transport", () => ({ installationRevocationScope: () => state.selected }));
beforeEach(() => {
  state.identity = { account: "central-owner-a", epoch: "browser-login-a" };
  state.selected = {
    account: "central-owner-a",
    target: {
      organizationId: "organization-a",
      serverId: "server-a",
      workspaceId: "workspace-a",
      bindingVersion: 1,
      keyFingerprint: "a".repeat(64),
    },
  };
  state.identityRead.mockReset().mockImplementation(async () => state.identity);
  clearWorkspaceDraftSession();
});

it("restores the same complete binding and changes ownership for every account, workspace, installation and login boundary", async () => {
  await hydrateWorkspaceDraftSession(() => true);
  const owner = workspaceDraftOwner("https://installation.example.test", "local-user-a");
  expect(owner).toMatch(/^[a-f0-9]{64}$/);
  const original = { ...state.selected.target };
  for (const patch of [
    { organizationId: "organization-b" },
    { serverId: "server-b" },
    { workspaceId: "workspace-b" },
    { bindingVersion: 2 },
    { keyFingerprint: "b".repeat(64) },
  ]) {
    state.selected.target = { ...original, ...patch };
    expect(workspaceDraftOwner("https://installation.example.test", "local-user-a")).not.toBe(
      owner,
    );
  }
  state.selected.target = original;
  expect(workspaceDraftOwner("https://installation.example.test", "local-user-a")).toBe(owner);
  expect(workspaceDraftOwner("https://installation.example.test", "local-user-b")).not.toBe(owner);
  state.selected.account = "central-owner-b";
  expect(workspaceDraftOwner("https://installation.example.test", "local-user-a")).toBeUndefined();
  state.selected.account = "central-owner-a";
  state.identity.epoch = "browser-login-b";
  await hydrateWorkspaceDraftSession(() => true);
  expect(workspaceDraftOwner("https://installation.example.test", "local-user-a")).not.toBe(owner);
});

it("does not publish a late hydration after the initiating session has retired", async () => {
  let finish!: (value: typeof state.identity) => void;
  state.identityRead.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let current = true;
  const pending = hydrateWorkspaceDraftSession(() => current);
  current = false;
  clearWorkspaceDraftSession();
  finish(state.identity);
  await pending;
  expect(workspaceDraftOwner("https://installation.example.test", "local-user-a")).toBeUndefined();
});
