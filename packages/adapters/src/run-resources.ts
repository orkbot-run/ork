// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { MarkdownMemoryStore } from "@orkbot/memory";
import { createArtifactStore } from "./artifact-store-factory.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { createAgentHomeStore } from "./home-object-store.js";
import { createRunSandbox } from "./host-aware-sandbox.js";
import { createMediaGenerationProvider } from "./media-generation-factory.js";
import { SpaceMemoryProviderResolver } from "./memory-provider-factory.js";
import { CodexCatalogCache } from "./pi-codex-catalog.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

export type RunResourcesOptions = Pick<ExecutorDeps, "prisma"> &
  Partial<Pick<ExecutorDeps, "runtime" | "sandbox">> & {
    secrets: ExecutorDeps["secretStore"];
    dataDir: string;
    runtimeKind: string;
    sessionRoot: string | undefined;
    sandboxKind: string;
    sandboxOptions: SandboxProviderOptions;
  };

export async function createRunResources(options: RunResourcesOptions) {
  const { prisma, secrets, dataDir } = options;
  const runtime =
    options.runtime ??
    (options.runtimeKind === "scripted"
      ? new ScriptedAgentRuntime()
      : new PiAgentRuntime({ sessionRoot: options.sessionRoot }));
  const sandbox =
    options.sandbox ??
    (await createRunSandbox(options.sandboxKind, {
      ...options.sandboxOptions,
      dataDir,
      prisma,
      secrets,
    }));

  return {
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    memoryProviders: new SpaceMemoryProviderResolver(prisma, secrets),
    home: createAgentHomeStore(dataDir, prisma),
    artifacts: createArtifactStore(dataDir, prisma),
    codexCatalog: new CodexCatalogCache(),
    mediaGeneration: createMediaGenerationProvider(),
  };
}
