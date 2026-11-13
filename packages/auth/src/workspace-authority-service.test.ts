// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RealtimeFanout } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { expect, it, vi } from "vitest";
import type { InstallationClient } from "./installation-client.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import { startWorkspaceAuthority } from "./workspace-authority-service.js";

const serverId = "10000000-0000-4000-8000-000000000001";

it("broadcasts a known refusal even when persisting device revocations fails", async () => {
  const publish = vi.fn(async () => {});
  const authority = new WorkspaceAuthority(
    {} as PrismaClient,
    {} as InstallationClient,
    "https://accounts.example.test",
    { publish } as unknown as RealtimeFanout,
  );
  const dispose = vi.spyOn(authority.window, "dispose");
  vi.spyOn(authority.personal, "refuseInstallation").mockRejectedValue(
    new Error("disk unavailable"),
  );
  await expect(authority.refuseInstallation(serverId)).rejects.toThrow("disk unavailable");
  expect(dispose).toHaveBeenCalledOnce();
  expect(publish).toHaveBeenCalledExactlyOnceWith(
    `installation-authority:${serverId}`,
    JSON.stringify({ source: authority.processId, refused: true }),
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
    configuration: vi.fn(async () => ({ serverId })),
  } as unknown as InstallationClient;
  const authority = new WorkspaceAuthority(
    {} as PrismaClient,
    installation,
    "https://accounts.example.test",
    realtime,
  );
  vi.spyOn(authority, "synchronize").mockResolvedValue({ workspaces: [] } as never);
  vi.spyOn(authority.personal, "refuseInstallation").mockResolvedValue();
  const refuse = vi.spyOn(authority, "refuseInstallation");
  const onError = vi.fn();
  const stop = startWorkspaceAuthority(installation, authority, onError, realtime);
  try {
    await vi.waitFor(() => expect(receive).toBeTypeOf("function"));
    receive!(JSON.stringify({ source: authority.processId, refused: true }));
    receive!(JSON.stringify({ source: 42, refused: true }));
    expect(refuse).not.toHaveBeenCalled();
    receive!(JSON.stringify({ source: "another-process", refused: true }));
    await vi.waitFor(() => expect(refuse).toHaveBeenCalledExactlyOnceWith(serverId, false));
    expect(realtime.publish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await stop();
  }
  expect(unsubscribe).toHaveBeenCalledOnce();
});
