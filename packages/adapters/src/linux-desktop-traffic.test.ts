// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { AdapterContext, ComputerRef } from "@orkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { e2bDesktop } from "./e2b-sandbox.js";
import { LinuxDesktop } from "./linux-desktop.js";
import type { NovitaDesktop } from "./novita-sandbox.js";
import { novitaDesktop } from "./novita-sandbox.js";
import { fakeNovita } from "./novita-sandbox.test-support.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  screenLeaseId: "lease",
  signal: new AbortController().signal,
} as AdapterContext;
const computer = {
  id: "computer",
  botId: "bot",
  kind: "fake",
  providerRef: "computer",
} as ComputerRef;

describe("desktop port access", () => {
  it("propagates adapter port access through the real sandbox session methods", async () => {
    const { provider, machines } = fakeNovita();
    const instance = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
    const machine = machines.get(instance.id)!.desktop;
    const raw = {
      sandboxId: instance.id,
      trafficAccessToken: "private-test-token",
    } as NovitaDesktop;
    machine.portHeaders = novitaDesktop(raw, async () => {}).portHeaders;
    const screen = await provider.connectScreen(instance, { view: "stream" }, context);
    const terminal = await provider.connectTerminal(instance, { controlToken: "control" }, context);
    for (const session of [screen, terminal]) {
      expect(session.headers).toEqual({ "E2B-Traffic-Access-Token": "private-test-token" });
      expect(session.url).not.toContain("private-test-token");
    }
  });

  it("passes current access headers to view, control and terminal sessions without adding them to URLs", async () => {
    let token: string | undefined = "first-secret";
    const raw = {
      sandboxId: "computer",
      getHost: (port: number) => `${port}.example.test`,
      get trafficAccessToken() {
        return token;
      },
    } as NovitaDesktop;
    const remote = novitaDesktop(raw, async () => {});
    const desktop = new LinuxDesktop({
      environment: async () => ({
        homeDir: "/home/user",
        workspaceDir: "/home/user",
        browserProfilesDir: "/home/user/profiles",
        displayStart: 1,
        portStart: 6100,
      }),
      run: async () => ({ code: 0, stdout: "ORKBOT_DESKTOP=0:view-token" }),
      screenUrl: async (_computer, port) => ({
        url: `https://${remote.getHost(port)}/vnc.html`,
        headers: remote.portHeaders?.(port),
      }),
    });
    const view = await desktop.connectScreen(computer, { view: "stream" }, context);
    expect(view.headers).toEqual({ "E2B-Traffic-Access-Token": "first-secret" });
    expect(view.url).not.toContain("first-secret");
    token = "rotated-secret";
    const control = await desktop.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "control" },
      context,
    );
    const terminal = await desktop.connectTerminal(computer, { controlToken: "control" }, context);
    for (const session of [control, terminal]) {
      expect(session.headers).toEqual({ "E2B-Traffic-Access-Token": "rotated-secret" });
      expect(session.url).not.toContain("rotated-secret");
    }
    token = undefined;
    expect(
      (await desktop.connectScreen(computer, { view: "stream" }, context)).headers,
    ).toBeUndefined();
  });

  it("reads current port credentials from the other supported remote desktop adapter", () => {
    let token: string | undefined = "first-secret";
    const source = {
      sandboxId: "computer",
      get trafficAccessToken() {
        return token;
      },
    } as Parameters<typeof e2bDesktop>[0];
    const remote = e2bDesktop(source);
    expect(remote.portHeaders?.(6100)).toEqual({ "E2B-Traffic-Access-Token": "first-secret" });
    token = undefined;
    expect(remote.portHeaders?.(6100)).toBeUndefined();
  });
});
