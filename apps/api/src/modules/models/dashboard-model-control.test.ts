// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";
import { dashboardModelControl } from "./dashboard-model-control.js";

it("binds dashboard commands to the current connected workspace and consumes the grant once", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const claimId = "a".repeat(64);
  const settings = {
    nativeAccountsOwnerKey: "owner-key",
    nativeAccountsOrganizationId: organizationId,
    nativeAccountsWorkspaceClaimId: claimId,
  };
  const used = new Set<string>();
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => settings) },
    account: { findFirst: vi.fn(async () => ({ userId: "owner" })) },
    space: { findFirst: vi.fn(async () => ({ id: "space" })) },
    spaceMember: {
      findFirst: vi.fn(async () => ({
        userId: "owner",
        spaceId: "space",
        member: { user: { email: "owner@example.test" } },
      })),
    },
    verification: {
      create: vi.fn(async ({ data }: { data: { id: string } }) => {
        if (used.has(data.id)) throw new Error("duplicate");
        used.add(data.id);
        return {};
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  } as unknown as PrismaClient;
  const verifyGrant = vi.fn(async (grant: string) => {
    if (grant !== "valid") throw new Error("invalid");
    return {
      id: "grant-1",
      subject: "dashboard-owner",
      organizationId,
      claimId,
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
  });
  const connectionStatus = vi.fn(async () => "connected" as const);
  const dispatch = vi.fn(async () => ({ ok: true }));
  const handler = dashboardModelControl({
    prisma,
    issuer: "https://accounts.example.test",
    origin: "https://server.example.test",
    bootstrapSecret: "test-secret",
    verifyGrant,
    connectionStatus,
    dispatch,
  });
  const call = (grant = "valid") =>
    handler(
      new Request("https://server.example.test/api/workspace/model-control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", input: { apiKey: "fake-key" }, grant }),
      }),
    );
  expect((await call("wrong")).status).toBe(400);
  expect((await call()).status).toBe(200);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "owner", spaceId: "space" }),
    "set",
    { apiKey: "fake-key" },
    expect.any(AbortSignal),
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect((await call()).status).toBe(400);
  expect(dispatch).toHaveBeenCalledTimes(1);
  used.clear();
  settings.nativeAccountsWorkspaceClaimId = "b".repeat(64);
  expect((await call()).status).toBe(403);
  expect(dispatch).toHaveBeenCalledTimes(1);
  settings.nativeAccountsWorkspaceClaimId = claimId;
  connectionStatus.mockResolvedValueOnce("unconnected" as never);
  expect((await call()).status).toBe(403);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
