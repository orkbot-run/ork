// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createCipheriv, createHash } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import { oidcAccountSubject } from "./oidc.js";
import { authorizeWorkspaceSession } from "./server-claim.js";

const issuer = "https://accounts.example.test";
const bootstrapSecret = "s".repeat(43);
const organizationId = "00000000-0000-4000-8000-000000000001";
const claimId = "a".repeat(64);
const receipt = "r".repeat(43);
const accountKey = oidcAccountSubject(issuer, "member");

function fixture() {
  const key = createHash("sha256")
    .update("orkbot-workspace-receipt-v1\0")
    .update(bootstrapSecret)
    .digest();
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${organizationId}:${claimId}`));
  const encrypted = Buffer.concat([cipher.update(receipt, "utf8"), cipher.final()]);
  const settings = {
    nativeAccountsOrganizationId: organizationId,
    nativeAccountsWorkspaceClaimId: claimId,
    nativeAccountsWorkspaceReceipt: `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`,
    nativeAccountsOwnerKey: oidcAccountSubject(issuer, "owner"),
  };
  const updateMember = vi.fn(async () => ({ count: 1 }));
  const updateSpace = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => settings) },
    session: { findFirst: vi.fn(async () => ({ id: "session" })) },
    verification: {
      findFirst: vi.fn(async () => ({ value: JSON.stringify([issuer, "user", accountKey]) })),
    },
    account: {
      findFirst: vi.fn(async (input: { where: { userId?: string } }) =>
        input.where.userId ? { id: "account" } : { userId: "owner" },
      ),
    },
    space: { findFirst: vi.fn(async () => ({ id: "space", organizationId: "local-org" })) },
    $transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ member: { updateMany: updateMember }, spaceMember: { updateMany: updateSpace } }),
  };
  const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ role: "member" }),
  );
  const run = () =>
    authorizeWorkspaceSession(prisma as unknown as PrismaClient, {
      issuer,
      bootstrapSecret,
      sessionId: "session",
      userId: "user",
      request: request as unknown as typeof fetch,
    });
  return { prisma, settings, request, run, updateMember, updateSpace };
}

describe("workspace session authorization", () => {
  it("checks the private connection and updates the local member role", async () => {
    const f = fixture();
    expect(await f.run()).toBe(true);
    expect(JSON.parse(String(f.request.mock.calls[0]?.[1]?.body))).toEqual({
      id: claimId,
      receipt,
      accountKey,
    });
    expect(f.updateMember).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "member" } }),
    );
    expect(f.updateSpace).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: "member" } }),
    );
  });
  it("denies a removed member and fails closed when Accounts is unavailable", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ role: null }));
    expect(await f.run()).toBe(false);
    f.request.mockRejectedValueOnce(new Error("offline"));
    expect(await f.run()).toBe(false);
    expect(f.updateMember).not.toHaveBeenCalled();
  });
  it("applies changed administrator permissions on the next request", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce(Response.json({ role: "admin" }));
    expect(await f.run()).toBe(true);
    expect(f.updateMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { role: "admin" } }),
    );
    f.request.mockResolvedValueOnce(Response.json({ role: "manager" }));
    expect(await f.run()).toBe(true);
    expect(f.updateMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { role: "member" } }),
    );
  });
  it("rejects an unverified session and a connection changed during the check", async () => {
    const f = fixture();
    f.prisma.verification.findFirst.mockResolvedValueOnce(null as never);
    expect(await f.run()).toBe(false);
    f.request.mockImplementationOnce(async () => {
      f.settings.nativeAccountsWorkspaceClaimId = "b".repeat(64);
      return Response.json({ role: "admin" });
    });
    expect(await f.run()).toBe(false);
  });
});
