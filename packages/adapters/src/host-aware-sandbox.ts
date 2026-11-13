// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

import { homedir } from "node:os";
import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerCapabilityTarget,
  ComputerInput,
  ComputerRef,
  ControlLeaseRef,
  DirectoryExportLimits,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  SecretStore,
  TerminalRequest,
  WorkspaceDirectoryRequest,
  WorkspaceExportLimits,
} from "@orkbot/adapter-kit";
import { inspectComputerCapabilities } from "@orkbot/adapter-kit";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import { getLogger } from "@orkbot/logging";
import { cancelComputerRunWork, providerKeepsHome } from "./computer-idle.js";
import { computerProviderDescriptor } from "./computer-provider-registry.js";
import { manageComputerWorkspaceDirectories } from "./computer-workspace.js";
import {
  ConfiguredSandbox,
  loadAccountComputerSettings,
  loadComputerOwnerSettings,
  loadComputerProviderSelection,
} from "./configured-sandbox.js";
import { assertHostCommandsAllowed, DesktopSandboxProvider } from "./desktop-sandbox.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

export function sandboxKindForBot(envKind: string, computerHost: string | null | undefined) {
  if (envKind === "docker" && computerHost === "this-mac") return "desktop";
  return envKind;
}

export async function createRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & {
    prisma?: PrismaClient;
    secrets?: Pick<SecretStore, "load" | "onChange">;
  },
): Promise<SandboxProvider> {
  const base = await createBaseRunSandbox(kind, opts);
  // With the database at hand, Settings can send computers elsewhere: an admin's choice for
  // everyone, or an account's own provider.
  if (!opts.prisma || !opts.secrets || kind === "desktop" || kind === "fake") return base;
  const { prisma, secrets } = opts;
  const configured = new ConfiguredSandbox(
    base,
    () => loadComputerProviderSelection(prisma, secrets, true),
    {
      onSecretChange: secrets.onChange?.bind(secrets),
      loadOwn: (homeKey) => loadComputerOwnerSettings(prisma, secrets, homeKey, true),
      loadOwnForUser: (userId) => loadAccountComputerSettings(prisma, secrets, userId, true),
      createProvider: (settings) =>
        createBaseRunSandbox(settings.provider, {
          ...opts,
          ...computerProviderDescriptor(settings.provider).verify(settings.values),
        }),
    },
  );
  // Startup never waits on the secret store or a saved provider: routing rereads them on first use.
  await configured
    .refresh()
    .catch((error) => getLogger().warn("computer_provider.load_failed", { error }));
  return configured;
}

async function createBaseRunSandbox(
  kind: string,
  opts: SandboxProviderOptions & { prisma?: PrismaClient },
): Promise<SandboxProvider> {
  if (kind === "desktop") {
    assertHostCommandsAllowed();
    if (opts.hostAccessAllowed)
      throw new Error("Workspace installations require an isolated computer provider");
    return new DesktopSandboxProvider({
      root: opts.dataDir,
      hostRoots: [homedir()],
    });
  }
  const prisma = opts.prisma;
  const primary = await createSandboxProvider(kind, {
    ...opts,
    referenceInUse: prisma
      ? async (computer) =>
          (await runAsSystem("check whether another computer shares a provider resource", () =>
            prisma.computer.count({
              where: {
                kind: computer.kind,
                providerRef: computer.providerRef,
                homeKey: { not: computer.botId },
                // One still saving its workspace needs the desktop until it finishes.
                state: { in: ["booting", "running", "suspending"] },
              },
            }),
          )) > 0
      : opts.referenceInUse,
    onUnsafeStop: opts.prisma
      ? async (providerRef) => {
          const quarantined = await opts.prisma!.computer.updateMany({
            where: { kind, providerRef },
            data: {
              state: "quarantined",
              screenUrl: null,
              screenGeneration: { increment: 1 },
              controlFence: { increment: 1 },
              controlHolder: "none",
              controlLeaseId: null,
              controlLeaseExpiresAt: null,
              controlBotId: null,
              controlRunId: null,
            },
          });
          if (quarantined.count === 0)
            throw new Error("Computer recovery requirement could not be recorded");
        }
      : opts.onUnsafeStop,
  });
  if (kind !== "docker" || !opts.prisma) return primary;
  return new HostAwareSandbox(
    primary,
    new HostComputerSandbox(opts.hostComputerUrl ?? "", opts.hostComputerToken ?? ""),
    async () => {
      if (opts.hostAccessAllowed && !(await opts.hostAccessAllowed())) return false;
      const settings = await opts.prisma!.deploymentSettings.findUnique({
        where: { id: "default" },
      });
      return settings?.computerHost === "this-mac";
    },
  );
}

export class HostAwareSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly isolated: SandboxProvider,
    private readonly host: SandboxProvider,
    private readonly hostEnabled: () => Promise<boolean>,
  ) {
    if (isolated.pageBrowser || host.pageBrowser) {
      this.pageBrowser = async (computer, request, context) => {
        const provider = await this.authorized(computer);
        return provider.pageBrowser
          ? provider.pageBrowser(computer, request, context)
          : Promise.resolve({
              ok: false,
              uncertain: false,
              fallback: "computer_act",
              error: "Page browser is unavailable on this computer.",
            });
      };
    }
  }

  ownsReference(computer: Pick<ComputerRef, "kind" | "providerRef">) {
    return this.route(computer).ownsReference?.(computer) ?? true;
  }

  describe() {
    return this.isolated.describe();
  }

  private route(computer: Pick<ComputerRef, "kind">) {
    return computer.kind === "desktop" ? this.host : this.isolated;
  }

  private async authorized(computer: Pick<ComputerRef, "kind">) {
    if (computer.kind === "desktop" && !(await this.hostEnabled()))
      throw new Error("Local computer access is disabled");
    return this.route(computer);
  }

  async provisionKind() {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    return provider.describe().id as ComputerRef["kind"];
  }

  async computerCapabilities(input: ComputerCapabilityTarget) {
    const unavailable = { start: false, screen: false, control: false, terminal: false };
    const next = (async () =>
      inspectComputerCapabilities((await this.hostEnabled()) ? this.host : this.isolated, {
        homeKey: input.homeKey,
      }))().catch(() => unavailable);
    const active = input.computer
      ? this.authorized(input.computer)
          .then((provider) => inspectComputerCapabilities(provider, input))
          .catch(() => unavailable)
      : next;
    return { ...(await active), start: (await next).start };
  }

  async provision(
    request: {
      botId: string;
      homePath: string;
      providerRef?: string;
      providerKind?: ComputerRef["kind"];
    },
    context: AdapterContext,
  ) {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    const providerKind = provider.describe().id;
    return provider.provision(
      {
        ...request,
        providerRef: request.providerKind === providerKind ? request.providerRef : undefined,
      },
      context,
    );
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    const provider = (await this.hostEnabled()) ? this.host : this.isolated;
    if (provider.describe().id !== computer.kind) return false;
    return provider.isRunning?.(computer, context) ?? false;
  }

  async isStopped(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    return (await this.authorized(computer)).isStopped?.(computer, context) ?? false;
  }

  async environment(computer: ComputerRef, context: AdapterContext) {
    const provider = await this.authorized(computer);
    return provider.environment?.(computer, context);
  }

  async prepare(computer: ComputerRef, context: AdapterContext) {
    return (await this.authorized(computer)).prepare(computer, context);
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    yield* (await this.authorized(computer)).execute(computer, request, context);
  }

  async workspaceDirectories(
    computer: ComputerRef,
    request: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return manageComputerWorkspaceDirectories(
      await this.authorized(computer),
      computer,
      request,
      context,
    );
  }

  cancelRunWork(computer: ComputerRef, computerId: string, runId: string, context: AdapterContext) {
    return cancelComputerRunWork(this.route(computer), computer, computerId, runId, context);
  }

  async connectScreen(computer: ComputerRef, request: ScreenRequest, context: AdapterContext) {
    return (await this.authorized(computer)).connectScreen(computer, request, context);
  }

  async connectTerminal(computer: ComputerRef, request: TerminalRequest, context: AdapterContext) {
    const provider = await this.authorized(computer);
    if (!provider.connectTerminal) {
      return Promise.reject(new Error("terminal is unavailable on this computer"));
    }
    return provider.connectTerminal(computer, request, context);
  }

  async sendInput(
    computer: ComputerRef,
    input: ComputerInput,
    lease: ControlLeaseRef,
    context: AdapterContext,
  ) {
    return (await this.authorized(computer)).sendInput(computer, input, lease, context);
  }

  async observe(computer: ComputerRef, context: AdapterContext) {
    return (await this.authorized(computer)).observe(computer, context);
  }

  async act(computer: ComputerRef, request: ComputerActionRequest, context: AdapterContext) {
    return (await this.authorized(computer)).act(computer, request, context);
  }

  async listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return (await this.authorized(computer)).listFiles(computer, path, context);
  }

  sharesWorkspace(computer: ComputerRef) {
    return this.route(computer).sharesWorkspace?.(computer) ?? false;
  }

  async readTransferFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    maxBytes: number,
  ) {
    const provider = await this.authorized(computer);
    if (!provider.readTransferFile)
      throw new Error("File transfer is unsupported on this computer");
    return provider.readTransferFile(computer, path, context, maxBytes);
  }

  async *exportDirectory(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    limits: DirectoryExportLimits,
  ) {
    const provider = await this.authorized(computer);
    if (!provider.exportDirectory)
      throw new Error("Directory transfer is unsupported on this computer");
    yield* provider.exportDirectory(computer, path, context, limits);
  }

  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    return (await this.authorized(computer)).readFile(computer, path, context, options);
  }

  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    return (await this.authorized(computer)).writeFile(computer, file, context);
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
    limits?: WorkspaceExportLimits,
  ) {
    yield* (await this.authorized(computer)).exportWorkspace(computer, context, limits);
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    return (await this.authorized(computer)).importWorkspace(computer, files, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext) {
    return (await this.authorized(computer)).snapshot(computer, context);
  }

  billsWhileRunning(computer: Pick<ComputerRef, "kind">): boolean {
    return this.route(computer).billsWhileRunning?.(computer) ?? false;
  }

  keepsHome(computer: ComputerRef) {
    return providerKeepsHome(this.route(computer), computer);
  }

  async keepAlive(computer: ComputerRef) {
    return (await this.authorized(computer)).keepAlive?.(computer) ?? Promise.resolve();
  }

  releaseScreen(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).releaseScreen?.(computer, context) ?? Promise.resolve();
  }

  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ) {
    return (
      (interactive ? await this.authorized(computer) : this.route(computer)).setScreenControl?.(
        computer,
        interactive,
        context,
        controlToken,
      ) ?? Promise.resolve()
    );
  }

  stop(computer: ComputerRef, context: AdapterContext, options?: { discardUnsaved?: boolean }) {
    return this.route(computer).stop(computer, context, options);
  }

  destroy(computer: ComputerRef, context: AdapterContext) {
    return this.route(computer).destroy(computer, context);
  }
}
