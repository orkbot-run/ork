// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import { PassThrough } from "node:stream";
import { resolveSupervisorToken } from "@orkbot/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  exec: vi.fn(),
  inspect: vi.fn(),
  stop: vi.fn(),
  kill: vi.fn(),
  wait: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    getContainer() {
      return mock;
    }
    getNetwork() {
      return {
        inspect: async () => {
          throw Object.assign(new Error("missing"), { statusCode: 404 });
        },
      };
    }
  },
}));
vi.mock("./supervisor-logic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervisor-logic.js")>()),
  withKeyedLock: mock.lock,
}));

import { supervisorApp } from "./index.js";

const headers = {
  authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
  "content-type": "application/json",
  "x-orkbot-bot-id": "bot",
  "x-orkbot-space-id": "space",
};
let dockerOutput: PassThrough;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  dockerOutput = new PassThrough();
  mock.inspect.mockResolvedValue({
    State: { Running: true },
    Config: {
      Labels: { "orkbot.managed": "true", "orkbot.botId": "bot", "orkbot.spaceId": "space" },
    },
  });
  mock.exec.mockResolvedValue({
    start: async () => dockerOutput,
    inspect: async () => ({ ExitCode: 0 }),
  });
  mock.lock.mockImplementation((_locks, _key, task) => task());
  mock.kill.mockResolvedValue(undefined);
  mock.wait.mockResolvedValue({ StatusCode: 137 });
  mock.stop.mockResolvedValue(undefined);
});
afterEach(() => {
  dockerOutput.destroy();
  vi.useRealTimers();
});
function exec(signal?: AbortSignal) {
  return supervisorApp.request("/computers/computer/exec", {
    method: "POST",
    headers,
    body: JSON.stringify({ argv: ["sleep", "60"] }),
    signal,
  });
}
function stop(discard = true) {
  return supervisorApp.request("/computers/computer/stop", {
    method: "POST",
    headers: { ...headers, ...(discard ? { "x-ork-sandbox-discard-unsaved": "true" } : {}) },
  });
}

describe("exec keepalive", () => {
  it("emits blank NDJSON lines every 15 seconds and clears the interval on completion", async () => {
    const response = await exec();
    const reader = response.body!.getReader();
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    let delivered = false;
    const first = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(delivered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(new TextDecoder().decode((await first).value)).toBe("\n");
    const second = reader.read();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await second).value)).toBe("\n");
    dockerOutput.end();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      '{"type":"exit","code":0}\n',
    );
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an idle heartbeat immediately without awaiting exec or leaking later errors", async () => {
    const response = await exec();
    await response.body!.cancel();
    expect(vi.getTimerCount()).toBe(0);
    dockerOutput.destroy(new Error("Docker stream disconnected"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the heartbeat immediately when the request aborts", async () => {
    const abort = new AbortController();
    const response = await exec(abort.signal);
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
    dockerOutput.end();
    expect(await response.text()).toBe("");
  });
});

describe("discard-unsaved stop", () => {
  it("kills a stubborn container without acquiring its screen lock or checkpointing", async () => {
    mock.lock.mockImplementation(() => new Promise(() => {}));
    mock.stop.mockImplementation(() => new Promise(() => {}));
    const response = await stop();
    expect(response.status).toBe(200);
    expect(mock.lock).not.toHaveBeenCalled();
    expect(mock.exec).not.toHaveBeenCalled();
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.kill).toHaveBeenCalledWith({
      signal: "SIGKILL",
      abortSignal: expect.any(AbortSignal),
    });
    expect(mock.wait).toHaveBeenCalledWith({
      condition: "not-running",
      abortSignal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("confirms termination when the container stops concurrently with kill", async () => {
    mock.kill.mockRejectedValue(Object.assign(new Error("not running"), { statusCode: 409 }));
    const response = await stop();
    expect(response.status).toBe(200);
    expect(mock.wait).toHaveBeenCalledOnce();
  });

  it.each(["kill", "wait"] as const)(
    "bounds a hung Docker %s request and aborts its HTTP signal",
    async (operation) => {
      mock[operation].mockImplementation(() => new Promise(() => {}));
      const request = stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await request).status).toBe(500);
      expect(mock.kill.mock.calls[0]![0].abortSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps ordinary stop serialized and checkpoints profiles before Docker stop", async () => {
    mock.exec.mockImplementation(async () => ({
      start: async () => {
        const output = new PassThrough();
        output.end();
        return output;
      },
      inspect: async () => ({ ExitCode: 0 }),
    }));
    const response = await stop(false);
    expect(response.status).toBe(200);
    expect(mock.lock).toHaveBeenCalled();
    expect(mock.exec).toHaveBeenCalledOnce();
    expect(mock.exec.mock.calls[0]![0].Cmd.join(" ")).toContain("browser");
    expect(mock.stop).toHaveBeenCalledOnce();
    expect(mock.exec.mock.invocationCallOrder[0]).toBeLessThan(
      mock.stop.mock.invocationCallOrder[0]!,
    );
    expect(mock.kill).not.toHaveBeenCalled();
  });
});
