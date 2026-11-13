// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import path from "node:path";
import { resolveSupervisorToken } from "@orkbot/core";
import Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_IMAGE, containerCreateOptions } from "./computer-spec.js";
import { supervisorApp } from "./index.js";

const headers = {
  authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
  "x-orkbot-bot-id": "home",
  "x-orkbot-space-id": "space",
};
function fixture() {
  const homePath = path.resolve(process.env.DATA_DIR ?? "./data", "homes/home");
  const options = containerCreateOptions({
    name: "computer",
    image: COMPUTER_IMAGE,
    botId: "home",
    spaceId: "space",
    homePath,
  });
  return {
    Config: options,
    HostConfig: options.HostConfig,
    State: { Running: true },
    Mounts: [{ Type: "bind", Destination: "/home/orkbot", Source: homePath, RW: true }],
  } as unknown as Docker.ContainerInspectInfo;
}
function inspectFixture(info: Docker.ContainerInspectInfo) {
  const exec = vi.fn();
  vi.spyOn(Docker.prototype, "getContainer").mockImplementation(
    (id) =>
      ({
        inspect: async () => {
          if (id !== "computer") throw new Error("not a container");
          return info;
        },
        exec,
      }) as unknown as Docker.Container,
  );
  return exec;
}
afterEach(() => vi.restoreAllMocks());
describe("workspace supervisor HTTP protocol", () => {
  it("keeps every versioned operation behind the service token", async () => {
    expect(
      (await supervisorApp.request("/workspace/v2/computers/computer/exec", { method: "POST" }))
        .status,
    ).toBe(401);
  });
  it("dispatches a verified computer through the versioned route", async () => {
    inspectFixture(fixture());
    const response = await supervisorApp.request("/workspace/v2/computers/computer", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ running: true });
  });
  it("refuses host mounts on an existing computer before any command runs", async () => {
    const info = fixture();
    info.Mounts.push({
      Type: "bind",
      Destination: "/shared",
      Source: "/host/shared",
      RW: true,
    } as Docker.ContainerInspectInfo["Mounts"][number]);
    const exec = inspectFixture(info);
    const response = await supervisorApp.request("/workspace/v2/computers/computer/exec", {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["pwd"] }),
    });
    expect(response.status).toBe(409);
    expect(exec).not.toHaveBeenCalled();
  });
  it("refuses a different workspace's computer before forwarding", async () => {
    inspectFixture(fixture());
    const response = await supervisorApp.request("/workspace/v2/computers/computer", {
      headers: { ...headers, "x-orkbot-space-id": "other" },
    });
    expect(response.status).toBe(409);
  });
});
