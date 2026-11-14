// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";
import { InstallationClient, InstallationRequestError } from "./installation-client.js";

it("only resumes locally pending or ready enrollment", async () => {
  const findUnique = vi.fn().mockResolvedValue(null);
  const client = new InstallationClient(
    { installationIdentity: { findUnique } } as unknown as PrismaClient,
    {
      issuer: "https://accounts.example.test",
      encryptionKey: "fixture-encryption-key-32-characters",
    },
  );
  const poll = vi.spyOn(client, "pollEnrollment").mockResolvedValue(null);
  await expect(client.resumePendingEnrollment()).resolves.toBeNull();
  findUnique.mockResolvedValueOnce({ state: "unregistered" });
  await expect(client.resumePendingEnrollment()).resolves.toBeNull();
  expect(poll).not.toHaveBeenCalled();
  for (const state of ["enrolling", "binding", "ready"]) {
    findUnique.mockResolvedValueOnce({ state });
    await client.resumePendingEnrollment();
  }
  expect(poll).toHaveBeenCalledTimes(3);
});

it("adds only an exact public HTTPS route with the current installation proof", async () => {
  const client = new InstallationClient({} as PrismaClient, {
    issuer: "https://accounts.example.test",
    encryptionKey: "fixture-encryption-key-32-characters",
  });
  const signed = vi.spyOn(client, "signedRequest").mockResolvedValue({
    response: { ok: true },
    nonce: "fixture",
    startedAt: 0,
  });
  const configuration = {
    serverId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: "f".repeat(64),
  };
  await client.addDirectRoute("https://server.example.test", configuration);
  expect(signed).toHaveBeenCalledExactlyOnceWith(
    "/servers/routes/add",
    {
      route: { kind: "direct", address: "https://server.example.test", deviceId: null },
      intentId: "794b1b84e55180d4d4d1aa86629a7ad65c72fa5051ff6aa1576fe4304ad03115",
    },
    configuration,
  );
  await expect(client.addDirectRoute("http://127.0.0.1:3000", configuration)).rejects.toThrow();
  expect(signed).toHaveBeenCalledOnce();
});

it("keeps the direct-route intent stable across restarts and changes it for a new binding or address", async () => {
  const options = {
    issuer: "https://accounts.example.test",
    encryptionKey: "fixture-encryption-key-32-characters",
  };
  const configuration = {
    serverId: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    bindingVersion: 1,
    keyFingerprint: "f".repeat(64),
  };
  const first = new InstallationClient({} as PrismaClient, options);
  const restarted = new InstallationClient({} as PrismaClient, options);
  const result = { response: { ok: true }, nonce: "fixture", startedAt: 0 };
  const original = vi.spyOn(first, "signedRequest").mockResolvedValue(result);
  const resumed = vi.spyOn(restarted, "signedRequest").mockResolvedValue(result);
  await first.addDirectRoute("https://server.example.test", configuration);
  await restarted.addDirectRoute("https://server.example.test", configuration);
  await restarted.addDirectRoute("https://other.example.test", configuration);
  await restarted.addDirectRoute("https://server.example.test", {
    ...configuration,
    bindingVersion: 2,
  });
  const id = (call: unknown[]) => (call[1] as { intentId: string }).intentId;
  const initial = id(original.mock.calls[0]!);
  expect(id(resumed.mock.calls[0]!)).toBe(initial);
  expect(id(resumed.mock.calls[1]!)).not.toBe(initial);
  expect(id(resumed.mock.calls[2]!)).not.toBe(initial);
});

it("resets only a centrally confirmed expired pending enrollment with a fenced write", async () => {
  const row = {
    issuer: "https://accounts.example.test",
    state: "enrolling",
    serverId: null,
    operationId: "operation",
    enrollmentId: "enrollment",
    receiptCipher: "cipher",
    requestedOrganizationId: "organization",
  };
  const findUnique = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const client = new InstallationClient(
    { installationIdentity: { findUnique, updateMany } } as unknown as PrismaClient,
    { issuer: row.issuer, encryptionKey: "fixture-encryption-key-32-characters" },
  );
  const internals = client as unknown as {
    receipt: () => Promise<string>;
    post: () => Promise<Record<string, unknown>>;
  };
  vi.spyOn(internals, "receipt").mockResolvedValue("receipt");
  const post = vi.spyOn(internals, "post").mockResolvedValue({ state: "pending" });
  await expect(client.resetExpiredEnrollment()).resolves.toBe(false);
  post.mockResolvedValueOnce({ state: "approved" });
  await expect(client.resetExpiredEnrollment()).resolves.toBe(false);
  post.mockRejectedValueOnce(new InstallationRequestError(410));
  await expect(client.resetExpiredEnrollment()).rejects.toThrow();
  post.mockRejectedValueOnce(new Error("network"));
  await expect(client.resetExpiredEnrollment()).rejects.toThrow();
  expect(updateMany).not.toHaveBeenCalled();
  post.mockResolvedValue({ state: "expired" });
  await expect(client.resetExpiredEnrollment()).resolves.toBe(true);
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      id: "local",
      issuer: row.issuer,
      state: "enrolling",
      serverId: null,
      operationId: row.operationId,
      enrollmentId: row.enrollmentId,
      receiptCipher: row.receiptCipher,
      requestedOrganizationId: row.requestedOrganizationId,
    },
    data: {
      state: "unregistered",
      operationId: expect.any(String),
      challenge: expect.any(String),
      enrollmentId: null,
      receiptCipher: null,
    },
  });
  updateMany.mockResolvedValueOnce({ count: 0 });
  await expect(client.resetExpiredEnrollment()).rejects.toThrow("enrollment changed");
});
