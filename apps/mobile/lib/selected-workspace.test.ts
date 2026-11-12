// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceTarget } from "@orkbot/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import {
  lastOrganizationWorkspace,
  saveSelectedWorkspace,
  selectedWorkspace,
} from "./selected-workspace";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    storage.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    storage.delete(key);
  },
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target: WorkspaceTarget = {
  organizationId: id(1),
  serverId: id(2),
  workspaceId: id(3),
  bindingVersion: 1,
  keyFingerprint: "a".repeat(64),
};
beforeEach(() => storage.clear());

it("keeps device workspace history separately for each organization and account", async () => {
  const company = { ...target, organizationId: id(4), workspaceId: id(5) };
  await saveSelectedWorkspace("account-a", "https://server.example.test", target);
  await saveSelectedWorkspace("account-a", "https://server.example.test", company);
  expect(await selectedWorkspace("account-a", "https://server.example.test")).toEqual(company);
  expect(await lastOrganizationWorkspace("account-a", target.organizationId)).toEqual(target);
  expect(await lastOrganizationWorkspace("account-a", company.organizationId)).toEqual(company);
  expect(await lastOrganizationWorkspace("account-b", target.organizationId)).toBeNull();
  expect(await selectedWorkspace("account-b", "https://server.example.test")).toBeNull();
  expect(await selectedWorkspace("account-a", "https://other.example.test")).toBeNull();
});

it("clears active selection without granting authority from remembered metadata", async () => {
  await saveSelectedWorkspace("account", "https://server.example.test", target);
  await saveSelectedWorkspace("account", "https://server.example.test");
  expect(await selectedWorkspace("account", "https://server.example.test")).toBeNull();
  expect(await lastOrganizationWorkspace("account", target.organizationId)).toEqual(target);
  for (const key of storage.keys())
    storage.set(key, JSON.stringify({ account: "another-account", target }));
  expect(await lastOrganizationWorkspace("account", target.organizationId)).toBeNull();
});
