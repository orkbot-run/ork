// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RealtimeFanout } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { afterEach, expect, it, vi } from "vitest";
import type { InstallationClient } from "./installation-client.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import { startWorkspaceAuthority } from "./workspace-authority-service.js";

const serverId = "10000000-0000-4000-8000-000000000001";
const configuration = {
  serverId,
  organizationId: "20000000-0000-4000-8000-000000000001",
  bindingVersion: 2,
  keyFingerprint: "f".repeat(64),
};

afterEach(() => vi.useRealTimers());

it("resumes self-host enrollment without publishing routes unless enabled", async () => {
  vi.useFakeTimers();
  const installation = {
    resumePendingEnrollment: vi.fn(async () => configuration),
    configuration: vi.fn(async () => configuration),
    addDirectRoute: vi.fn(),
  } as unknown as InstallationClient;
  const authority = {
    synchronize: vi.fn(async () => ({ workspaces: [] })),
    dispose: vi.fn(),
  } as unknown as WorkspaceAuthority;
  let stop = startWorkspaceAuthority(installation, authority, vi.fn(), undefined, undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(installation.resumePendingEnrollment).toHaveBeenCalledOnce();
  expect(installation.addDirectRoute).not.toHaveBeenCalled();
  await stop();
  vi.mocked(installation.resumePendingEnrollment).mockClear();
  stop = startWorkspaceAuthority(installation, authority, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(installation.configuration).toHaveBeenCalledOnce();
  expect(installation.resumePendingEnrollment).not.toHaveBeenCalled();
  await stop();
});

it("resumes pending enrollment and retries additive route publication after a restart or outage", async () => {
  vi.useFakeTimers();
  const installation = {
    resumePendingEnrollment: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(configuration),
    addDirectRoute: vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined),
  } as unknown as InstallationClient;
  const authority = {
    synchronize: vi.fn(async () => ({ workspaces: [] })),
    dispose: vi.fn(),
  } as unknown as WorkspaceAuthority;
  const onError = vi.fn();
  const origin = "https://server.example.test";
  let stop = startWorkspaceAuthority(installation, authority, onError, undefined, origin, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(installation.addDirectRoute).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(installation.addDirectRoute).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledOnce();
  expect(authority.synchronize).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(installation.addDirectRoute).toHaveBeenCalledTimes(2);
  expect(installation.addDirectRoute).toHaveBeenLastCalledWith(origin, configuration);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(installation.addDirectRoute).toHaveBeenCalledTimes(2);
  await stop();
  stop = startWorkspaceAuthority(installation, authority, onError, undefined, origin, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(installation.addDirectRoute).toHaveBeenCalledTimes(3);
  await stop();
});

it("broadcasts a known refusal even when persisting device revocations fails", async () => {
  const publish = vi.fn(async () => {});
  const authority = new WorkspaceAuthority(
    {
      $transaction: async (run: (tx: unknown) => Promise<void>) =>
        run({
          $queryRaw: async () => [],
          installationIdentity: {
            findUnique: async () => ({
              ...configuration,
              issuer: "https://accounts.example.test",
              centralOrganizationId: configuration.organizationId,
            }),
            findUniqueOrThrow: async () => configuration,
          },
        }),
    } as unknown as PrismaClient,
    {} as InstallationClient,
    "https://accounts.example.test",
    { publish } as unknown as RealtimeFanout,
  );
  const dispose = vi.spyOn(authority.window, "dispose");
  vi.spyOn(authority.personal, "refuseInstallation").mockRejectedValue(
    new Error("disk unavailable"),
  );
  await expect(
    authority.refuseInstallation(serverId, true, undefined, configuration),
  ).rejects.toThrow("disk unavailable");
  expect(dispose).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    `installation-authority:${serverId}`,
    JSON.stringify({
      source: authority.processId,
      refused: true,
      serverId,
      bindingVersion: configuration.bindingVersion,
      keyFingerprint: configuration.keyFingerprint,
    }),
  );
});

it("applies another process's refusal without rebroadcasting it or accepting self events", async () => {
  let receive: ((payload: string) => void) | undefined;
  const unsubscribe = vi.fn(async () => {});
  const realtime = {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(async (_channel: string, callback: (payload: string) => void) => {
      receive = callback;
      return unsubscribe;
    }),
  } as unknown as RealtimeFanout;
  const installation = {
    configuration: vi.fn(async () => configuration),
  } as unknown as InstallationClient;
  const authority = new WorkspaceAuthority(
    {} as PrismaClient,
    installation,
    "https://accounts.example.test",
    realtime,
  );
  vi.spyOn(authority, "synchronize").mockResolvedValue({ workspaces: [] } as never);
  vi.spyOn(authority.personal, "refuseInstallation").mockResolvedValue();
  const refuse = vi.spyOn(authority, "refuseInstallation").mockResolvedValue();
  const onError = vi.fn();
  const stop = startWorkspaceAuthority(installation, authority, onError, realtime);
  try {
    await vi.waitFor(() => expect(receive).toBeTypeOf("function"));
    receive!(JSON.stringify({ source: authority.processId, refused: true }));
    receive!(JSON.stringify({ source: 42, refused: true }));
    expect(refuse).not.toHaveBeenCalled();
    receive!(JSON.stringify({ source: "another-process", refused: true }));
    receive!(
      JSON.stringify({
        source: "another-process",
        refused: true,
        serverId,
        bindingVersion: 1,
        keyFingerprint: "invalid",
      }),
    );
    expect(refuse).not.toHaveBeenCalled();
    receive!(
      JSON.stringify({
        source: "another-process",
        refused: true,
        serverId,
        bindingVersion: 1,
        keyFingerprint: configuration.keyFingerprint,
      }),
    );
    await vi.waitFor(() =>
      expect(refuse).toHaveBeenCalledExactlyOnceWith(serverId, false, undefined, {
        ...configuration,
        bindingVersion: 1,
      }),
    );
    const invalidate = vi.spyOn(authority, "invalidate");
    const gate = vi.spyOn(authority, "invalidateProjection").mockResolvedValue(false);
    const workspace = "30000000-0000-4000-8000-000000000001";
    receive!(JSON.stringify({ source: "another-process", ids: [workspace] }));
    expect(gate).not.toHaveBeenCalled();
    receive!(
      JSON.stringify({
        source: "another-process",
        ids: [workspace],
        serverId,
        bindingVersion: 1,
        keyFingerprint: configuration.keyFingerprint,
      }),
    );
    await vi.waitFor(() =>
      expect(gate).toHaveBeenCalledExactlyOnceWith({ ...configuration, bindingVersion: 1 }, [
        workspace,
      ]),
    );
    expect(invalidate).not.toHaveBeenCalled();
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});
