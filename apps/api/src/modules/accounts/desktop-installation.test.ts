// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceProjection } from "@orkbot/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountDesktopInstallation } from "./desktop-installation.js";

const organizationId = "10000000-0000-4000-8000-000000000001";
const serverId = "20000000-0000-4000-8000-000000000001";
const workspaceId = "30000000-0000-4000-8000-000000000001";
const token = "ab".repeat(32);
const accountKey = "cd".repeat(32);
const configuration = {
  organizationId,
  serverId,
  bindingVersion: 1,
  keyFingerprint: "ef".repeat(32),
};
const complete = {
  action: "complete",
  ...configuration,
  workspaceId,
  delegateAI: true,
  routes: [{ kind: "local", address: "http://127.0.0.1:45173", deviceId: workspaceId }],
};
function fixture(owner: string | undefined = accountKey) {
  const app = new Hono();
  const installation = {
    resumeEnrollment: vi.fn(async () => ({ state: "ready" as const, ...configuration })),
    configuration: vi.fn(async () => configuration),
    publishRoutes: vi.fn(async (_routes: unknown, _configuration: unknown) => {}),
  };
  const projection = {
    ...configuration,
    workspaces: [{ id: workspaceId, state: "ready" }],
  } as WorkspaceProjection;
  const authority = {
    synchronize: vi.fn(async () => projection),
    provisionWorkspace: vi.fn(async () => {}),
  };
  const delegate = vi.fn(async (_account: string, _fingerprint: string, _version: number) => {});
  mountDesktopInstallation(app, { token, accountKey: owner, installation, authority, delegate });
  const request = (body: unknown, supplied: string | null = token) =>
    app.request("/api/desktop-settings/installation", {
      method: "POST",
      headers: {
        cookie: "session=central-or-product-session",
        authorization: "Bearer accounts-token-is-insufficient",
        ...(supplied === null ? {} : { "x-orkbot-desktop-stack-token": supplied }),
      },
      body: JSON.stringify(body),
    });
  return { installation, authority, delegate, request };
}
describe("native Docker installation capability", () => {
  it("does not accept login tokens or a capability for another installation", async () => {
    const f = fixture();
    for (const supplied of [null, "", "11".repeat(32), token.toUpperCase()])
      expect((await f.request({ action: "enroll", organizationId }, supplied)).status).toBe(401);
    expect(f.installation.resumeEnrollment).not.toHaveBeenCalled();
    expect((await fixture("").request({ action: "enroll", organizationId })).status).toBe(401);
  });
  it("resumes enrollment without accepting a caller-selected owner or credentials", async () => {
    const f = fixture();
    expect((await f.request({ action: "enroll", organizationId, accountKey })).status).toBe(400);
    expect(
      (await f.request({ action: "enroll", organizationId, apiKey: "never-accepted" })).status,
    ).toBe(400);
    const response = await f.request({ action: "enroll", organizationId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state: "ready", ...configuration });
    expect(f.installation.resumeEnrollment).toHaveBeenCalledExactlyOnceWith(
      "This computer",
      organizationId,
    );
  });
  it("requires the complete installation identity before provisioning or publishing", async () => {
    const f = fixture();
    for (const altered of [
      { organizationId: serverId },
      { serverId: organizationId },
      { bindingVersion: 2 },
      { keyFingerprint: token },
    ])
      expect((await f.request({ ...complete, ...altered })).status).toBe(409);
    expect(f.authority.synchronize).not.toHaveBeenCalled();
    expect(f.delegate).not.toHaveBeenCalled();
  });
  it("never announces readiness or delegates AI before both workspace acknowledgements", async () => {
    const f = fixture();
    f.authority.synchronize.mockResolvedValue({ workspaces: [] } as unknown as WorkspaceProjection);
    expect((await f.request(complete)).status).toBe(403);
    expect(f.authority.provisionWorkspace).not.toHaveBeenCalled();
    f.authority.synchronize.mockResolvedValue({
      ...configuration,
      workspaces: [{ id: workspaceId, state: "provisioning" }],
    } as WorkspaceProjection);
    expect((await f.request(complete)).status).toBe(409);
    expect(f.installation.publishRoutes).not.toHaveBeenCalled();
    expect(f.delegate).not.toHaveBeenCalled();
  });
  it("publishes validated device routes and delegates only the pinned local account", async () => {
    const f = fixture();
    expect(
      (
        await f.request({
          ...complete,
          routes: [{ kind: "local", address: "http://other.example.test", deviceId: workspaceId }],
        })
      ).status,
    ).toBe(400);
    const response = await f.request(complete);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "ready", ...configuration, workspaceId });
    expect(f.authority.provisionWorkspace).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(f.installation.publishRoutes).toHaveBeenCalledExactlyOnceWith(
      complete.routes,
      configuration,
    );
    expect(f.delegate).toHaveBeenCalledExactlyOnceWith(
      accountKey,
      configuration.keyFingerprint,
      configuration.bindingVersion,
    );
    expect(f.installation.publishRoutes.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.authority.synchronize.mock.invocationCallOrder[1]!,
    );
  });
  it("redacts failed operations and keeps their next retry available", async () => {
    const f = fixture();
    f.installation.publishRoutes.mockRejectedValueOnce(new Error("provider-key-and-receipt"));
    const response = await f.request(complete);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("provider-key-and-receipt");
    expect(f.delegate).not.toHaveBeenCalled();
    expect((await f.request(complete)).status).toBe(200);
  });
  it("does not restore a revoked AI delegation when reopening an already completed install", async () => {
    const f = fixture();
    expect((await f.request({ ...complete, delegateAI: false })).status).toBe(200);
    expect(f.delegate).not.toHaveBeenCalled();
    expect(f.installation.publishRoutes).toHaveBeenCalledOnce();
  });
  it("rejects a binding changed during provisioning before publishing or delegating", async () => {
    const f = fixture();
    f.authority.synchronize.mockResolvedValueOnce({
      ...configuration,
      workspaces: [{ id: workspaceId, state: "ready" }],
    } as WorkspaceProjection);
    f.authority.synchronize.mockResolvedValueOnce({
      ...configuration,
      bindingVersion: 2,
      workspaces: [{ id: workspaceId, state: "ready" }],
    } as WorkspaceProjection);
    expect((await f.request(complete)).status).toBe(409);
    expect(f.installation.publishRoutes).not.toHaveBeenCalled();
    expect(f.delegate).not.toHaveBeenCalled();
  });
});
