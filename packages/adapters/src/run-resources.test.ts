// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@orkbot/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as HostAwareModule from "./host-aware-sandbox.js";
import type * as PiRuntimeModule from "./pi-runtime.js";
import type * as ScriptedRuntimeModule from "./scripted-runtime.js";

const created = vi.hoisted(() => ({ pi: vi.fn(), scripted: vi.fn(), sandbox: vi.fn() }));
vi.mock("./pi-runtime.js", async (original) => {
  const module = await original<typeof PiRuntimeModule>();
  return {
    ...module,
    PiAgentRuntime: class extends module.PiAgentRuntime {
      constructor(...args: ConstructorParameters<typeof module.PiAgentRuntime>) {
        super(...args);
        created.pi(...args);
      }
    },
  };
});
vi.mock("./scripted-runtime.js", async (original) => {
  const module = await original<typeof ScriptedRuntimeModule>();
  return {
    ...module,
    ScriptedAgentRuntime: class extends module.ScriptedAgentRuntime {
      constructor() {
        super();
        created.scripted();
      }
    },
  };
});
vi.mock("./host-aware-sandbox.js", async (original) => {
  const module = await original<typeof HostAwareModule>();
  return {
    ...module,
    createRunSandbox: async (...args: Parameters<typeof module.createRunSandbox>) => {
      created.sandbox(...args);
      return module.createRunSandbox(...args);
    },
  };
});

import { LocalAgentHomeStore } from "./home.js";
import { NoneSandboxProvider } from "./none-sandbox.js";
import type { RunResourcesOptions } from "./run-resources.js";
import { createRunResources } from "./run-resources.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";
import { EncryptedSecretStore } from "./secrets.js";

const directories: string[] = [];
const context = {
  spaceId: "fixture-space",
  userId: "fixture-user",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OBJECT_STORAGE_BUCKET", "");
  vi.stubEnv("MEDIA_GENERATION_PROVIDER", "fake");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture(): Promise<RunResourcesOptions> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ork-run-resources-"));
  directories.push(dataDir);
  return {
    prisma: {} as PrismaClient,
    secrets: new EncryptedSecretStore("a".repeat(64)),
    dataDir,
    runtimeKind: "scripted",
    sessionRoot: undefined,
    sandboxKind: "fake",
    sandboxOptions: {},
  };
}

describe("process run resources", () => {
  it("uses injected runtime and sandbox without constructing or validating their fallbacks", async () => {
    const options = await fixture();
    const runtime = new ScriptedAgentRuntime();
    const sandbox = new NoneSandboxProvider("Fixture sandbox");
    created.scripted.mockClear();
    const resources = await createRunResources({
      ...options,
      runtime,
      sandbox,
      runtimeKind: "pi",
      sandboxKind: "invalid-provider",
    });
    expect(resources.runtime).toBe(runtime);
    expect(resources.sandbox).toBe(sandbox);
    expect(created.pi).not.toHaveBeenCalled();
    expect(created.scripted).not.toHaveBeenCalled();
    expect(created.sandbox).not.toHaveBeenCalled();
    await expect(
      resources.sandbox.provision({ botId: "bot", homePath: "/unused" }, context),
    ).rejects.toThrow("Fixture sandbox");
  });

  it("keeps explicitly disabled transcript recording off even when the process environment enables it", async () => {
    vi.stubEnv("PI_SESSION_RECORDING", "true");
    const options = await fixture();
    const resources = await createRunResources({
      ...options,
      runtimeKind: "pi",
      sessionRoot: undefined,
    });
    expect(resources.runtime.describe().id).toBe("pi");
    expect(created.pi).toHaveBeenCalledExactlyOnceWith({ sessionRoot: undefined });
    expect(created.scripted).not.toHaveBeenCalled();
  });

  it("preserves an explicit session directory even when environment recording is disabled", async () => {
    vi.stubEnv("PI_SESSION_RECORDING", "false");
    const options = await fixture();
    const sessionRoot = path.join(options.dataDir, "chosen-sessions");
    await createRunResources({ ...options, runtimeKind: "pi", sessionRoot });
    expect(created.pi).toHaveBeenCalledExactlyOnceWith({ sessionRoot });
  });

  it("keeps the process data directory and credentials authoritative over provider options", async () => {
    const options = await fixture();
    const otherDatabase = {} as PrismaClient;
    const otherSecrets = new EncryptedSecretStore("b".repeat(64));
    await createRunResources({
      ...options,
      sandboxOptions: {
        dataDir: "/unused-other-directory",
        prisma: otherDatabase,
        secrets: otherSecrets,
      } as RunResourcesOptions["sandboxOptions"],
    });
    expect(created.sandbox.mock.calls[0]?.[1]).toMatchObject({
      dataDir: options.dataDir,
      prisma: options.prisma,
      secrets: options.secrets,
    });
  });

  it("creates independent process resources while sharing persisted home and artifact data", async () => {
    const options = await fixture();
    vi.stubEnv("DATA_DIR", path.join(options.dataDir, "other-environment-root"));
    const api = await createRunResources(options);
    const worker = await createRunResources(options);
    for (const key of [
      "runtime",
      "sandbox",
      "memory",
      "memoryProviders",
      "home",
      "artifacts",
      "codexCatalog",
      "mediaGeneration",
    ] as const)
      expect(api[key]).not.toBe(worker[key]);
    expect(created.scripted).toHaveBeenCalledTimes(2);
    expect(created.sandbox).toHaveBeenCalledTimes(2);

    await api.home.writeFile("bot", "notes.md", "Saved by the API", context);
    expect(await readFile(path.join(options.dataDir, "homes/bot/notes.md"), "utf8")).toBe(
      "Saved by the API",
    );
    expect(await worker.home.readFile("bot", "notes.md", context)).toBe("Saved by the API");
    await worker.home.writeFile("bot", "notes.md", "Updated by the worker", context);
    const saved = await api.artifacts.put(
      {
        name: "result.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("Persisted artifact"),
      },
      context,
    );
    expect(new TextDecoder().decode(await worker.artifacts.get(saved.id, context))).toBe(
      "Persisted artifact",
    );

    const restarted = await createRunResources(options);
    expect(await restarted.home.readFile("bot", "notes.md", context)).toBe("Updated by the worker");
    expect(new TextDecoder().decode(await restarted.artifacts.get(saved.id, context))).toBe(
      "Persisted artifact",
    );
    await expect(
      restarted.artifacts.get(saved.id, { ...context, spaceId: "different-space" }),
    ).rejects.toThrow();
  });

  it("returns resources without starting home cleanup or its own lifecycle", async () => {
    const cleanup = vi
      .spyOn(LocalAgentHomeStore.prototype, "removeStaleStaging")
      .mockImplementation(() => new Promise<number>(() => {}));
    const resources = await createRunResources(await fixture());
    expect(resources.home.describe().id).toBe("local-fs");
    expect(cleanup).not.toHaveBeenCalled();
  });
});
