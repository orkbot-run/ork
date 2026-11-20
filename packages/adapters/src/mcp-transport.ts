// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 behavior is preserved; bounded discovery and guarded proxy changes follow LICENSE.md.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { isLocalhostOrLoopbackIp } from "@orkbot/contracts";
import { combineSignals } from "./connector-safety.js";
import { closeMcpResource } from "./mcp-close.js";
import type { McpDiscoveryLimits, McpDiscoveryResult } from "./mcp-discovery.js";
import { mcpDiscoveryLimits } from "./mcp-discovery.js";
import { createMcpClient } from "./mcp-output-schema.js";
import type { InstalledMcpBin } from "./mcp-package-installer.js";
import {
  isInstalledMcpBin,
  isNpxCommand,
  isPackageRunnerCommand,
} from "./mcp-package-installer.js";
import { limitMcpResponseBody } from "./mcp-response-limit.js";
import type { McpFormCallOptions } from "./mcp-tool-call.js";
import { callMcpToolWithDeadline, installMcpFormHandler, mcpCallScope } from "./mcp-tool-call.js";

import type { RemoteTransportDependencies, SafeRemoteFetch } from "./remote-mcp.js";
import {
  ConnectorRedirectError,
  createSafeRemoteFetch,
  listMcpTools,
  RemoteMcpTransportError,
} from "./remote-mcp.js";

export type McpRemoteTransport = "streamable-http" | "sse";

export interface McpUrlPolicy {
  maxUrlLength?: number;
  /** Permit plain HTTP only on the configured loopback resource's exact origin.
   * Requests only honour it together with `allowPrivateEndpoint`: loopback is private. */
  allowHttpLocalhost?: boolean;
  /** Permit configured credentials on an explicitly local HTTP endpoint. */
  allowLocalHttpCredentials?: boolean;
  /** Permit RFC1918 / Docker-network hosts when the operator enabled the escape. */
  allowPrivateEndpoint?: boolean;
  /** Hosts allowed after redirects (redirects are rejected by default). */
  allowedHosts?: readonly string[];
}

export interface McpHeaderPolicy {
  /** Additional SDK request headers allowed beyond defaults and configured headers. */
  allowedHeaders?: readonly string[];
  headers?: Record<string, string>;
}

export interface McpRemoteOptions {
  url: string | URL;
  transport?: McpRemoteTransport;
  urlPolicy?: McpUrlPolicy;
  headerPolicy?: McpHeaderPolicy;
  /** Opt in to the deprecated HTTP+SSE transport. */
  allowLegacySse?: boolean;
  /** Fall back to SSE only after a fresh Streamable HTTP client fails. */
  fallbackToSse?: boolean;
  /**
   * Let the official SDK own re-authentication and request retry. `wrapFetch`
   * lets the provider serve the SDK's token refresh itself.
   */
  authProvider?: OAuthClientProvider & {
    wrapFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
  };
  network?: RemoteTransportDependencies;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpStdioOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Exact executable allowlist. Stdio is otherwise disabled. */
  allowedCommands: readonly string[];
  /**
   * Launch this managed package bin instead of `command`, with `args` as the bin's own
   * arguments. The allowlist still applies to `command` (the configured launcher, such as
   * `npx`); only bins issued by `ensureMcpPackage` are accepted here.
   */
  installedBin?: InstalledMcpBin;
  maxBufferSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The process exited or never answered; the message carries the tail of its stderr. */
export class McpStdioLaunchError extends Error {
  constructor(
    cause: unknown,
    readonly stderr: string,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(stderr ? `${message}\nstderr: ${stderr}` : message, { cause });
    this.name = "McpStdioLaunchError";
  }
}

const STDERR_TAIL_CHARS = 4_096;
/** Terminal colour/cursor sequences (ESC [ ... letter) that npm and friends print. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

/** Keeps the last few KB a process wrote to stderr, without terminal escapes. */
class StderrTail {
  private text = "";

  push(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-STDERR_TAIL_CHARS * 2);
  }

  toString(): string {
    return this.text.replace(ANSI_ESCAPE, "").trim().slice(-STDERR_TAIL_CHARS);
  }
}

export interface McpClientOptions {
  name?: string;
  version?: string;
  capabilities?: ConstructorParameters<typeof Client>[1];
  /** Dedicated invocation for transports without request-stream correlation. */
  isolatedElicitation?: boolean;
}

const DEFAULT_HEADERS = ["accept", "content-type", "authorization", "user-agent"];
const RESOURCE_HEADERS = new Set(["mcp-session-id", "mcp-protocol-version", "last-event-id"]);
const DEFAULT_MAX_URL_LENGTH = 2_048;
// A Request owns the abort link for its signal in affected Node versions. Keep
// that owner alive while a fetch/body still retains the signal, without keeping
// completed requests alive once the signal is no longer used.
const requestSignalOwners = new WeakMap<AbortSignal, Request>();

function validateUrl(raw: string | URL, policy: McpUrlPolicy = {}): URL {
  const url = new URL(raw.toString());
  const max = policy.maxUrlLength ?? DEFAULT_MAX_URL_LENGTH;
  if (url.toString().length > max) throw new Error(`MCP URL exceeds ${max} characters`);
  if (url.username || url.password || url.hash)
    throw new Error("MCP URL must not contain credentials or a fragment");
  const local = isLocalhostOrLoopbackIp(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && policy.allowHttpLocalhost === true && local) &&
    !(url.protocol === "http:" && policy.allowPrivateEndpoint === true)
  ) {
    throw new Error("MCP remote URL must use HTTPS");
  }
  if (policy.allowedHosts && !policy.allowedHosts.includes(url.hostname)) {
    throw new Error(`MCP host is not in the allowlist: ${url.hostname}`);
  }
  return url;
}

export function secureFetch(
  resourceUrl: URL,
  urlPolicy: McpUrlPolicy,
  headerPolicy: McpHeaderPolicy = {},
  network: RemoteTransportDependencies = {},
): SafeRemoteFetch {
  // A local hostname is not authorization: the configured loopback origin
  // needs the deployment-owner private-endpoint escape as well.
  const localOrigin =
    urlPolicy.allowHttpLocalhost === true &&
    urlPolicy.allowPrivateEndpoint === true &&
    resourceUrl.protocol === "http:" &&
    isLocalhostOrLoopbackIp(resourceUrl.hostname)
      ? resourceUrl.origin
      : undefined;
  const allowed = new Set(
    [
      ...DEFAULT_HEADERS,
      ...(headerPolicy.allowedHeaders ?? []),
      ...Object.keys(headerPolicy.headers ?? {}),
    ].map((header) => header.toLowerCase()),
  );
  const configured = Object.entries(headerPolicy.headers ?? {}).filter(([name]) =>
    allowed.has(name.toLowerCase()),
  );
  const configuredValues = new Map(
    configured.map(([name, value]) => [name.toLowerCase(), value] as const),
  );
  const configuredCredentialValues = new Set(configuredValues.values());
  const configuredNames = new Set(configuredValues.keys());
  const localCredentialHeaders = new Set([
    ...configuredNames,
    "authorization",
    "cookie",
    "proxy-authorization",
  ]);
  const safeRemoteFetch = createSafeRemoteFetch(network.fetch, network.resolveHostname, {
    allowPrivateEndpoint: urlPolicy.allowPrivateEndpoint,
  });
  const request = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) requestSignalOwners.set(input.signal, input);
    const source = new Request(input, init);
    // OAuth challenges and rediscovery can supply new URLs. Only the explicitly
    // configured local resource origin (including port) may bypass remote policy.
    const url = validateUrl(source.url, {
      ...urlPolicy,
      allowHttpLocalhost: new URL(source.url).origin === localOrigin,
    });
    const headers = new Headers();
    for (const [name, value] of source.headers) {
      const normalized = name.toLowerCase();
      if (RESOURCE_HEADERS.has(normalized)) {
        if (url.origin !== resourceUrl.origin) continue;
      } else if (!allowed.has(normalized)) continue;
      if (url.origin !== resourceUrl.origin && configuredCredentialValues.has(value)) continue;
      headers.set(name, value);
    }
    const localHttp = url.protocol === "http:" && isLocalhostOrLoopbackIp(url.hostname);
    if (localHttp && urlPolicy.allowLocalHttpCredentials !== true) {
      for (const name of [...headers.keys()]) {
        if (localCredentialHeaders.has(name.toLowerCase())) headers.delete(name);
      }
    }
    if (!localHttp && url.origin === resourceUrl.origin) {
      for (const [name, value] of configured) headers.set(name, value);
    }
    // Buffer the body: a re-wrapped Request body is a stream without a replayable
    // source, and undici fails the whole request when a server answers 401 early
    // (the OAuth challenge) instead of draining it.
    const body =
      source.method === "GET" || source.method === "HEAD" ? undefined : await source.arrayBuffer();
    const requestInit = {
      method: source.method,
      headers,
      body,
      redirect: "manual",
      // Request's derived signal can lose its abort link when the temporary
      // Request is collected. Forward the caller's signal for the whole SSE body.
      signal:
        init?.signal !== undefined
          ? init.signal
          : input instanceof Request
            ? input.signal
            : undefined,
    } satisfies RequestInit;
    let response: Response;
    try {
      response = await safeRemoteFetch(url, requestInit);
    } catch (error) {
      if (localHttp && error instanceof ConnectorRedirectError) {
        throw new Error(
          "MCP redirects are not permitted; configure the final HTTPS URL explicitly",
        );
      }
      if (requestInit.signal?.aborted) throw error;
      throw new RemoteMcpTransportError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    return limitMcpResponseBody(response, headers);
  };
  const result = request as SafeRemoteFetch;
  result.close = () => safeRemoteFetch.close();
  return result;
}

/**
 * Some providers (Brex) advertise OAuth discovery and registration hosts that
 * are not publicly routable, while mirroring the same well-known documents on
 * the MCP endpoint's own origin. When a request to another origin cannot
 * connect, retry the same path on the endpoint origin before giving up.
 */
export function withEndpointOriginFallback(
  endpointOrigin: string,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  // Credentials must not be replayed to a different origin than the one the
  // SDK addressed, so the retry drops auth/session headers.
  const SENSITIVE_RETRY_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
  const sanitizedInit = (init?: RequestInit): RequestInit | undefined => {
    if (!init?.headers) return init;
    const headers = new Headers(init.headers);
    for (const name of [...headers.keys()]) {
      if (SENSITIVE_RETRY_HEADERS.has(name.toLowerCase())) headers.delete(name);
    }
    return { ...init, headers };
  };
  return async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    if (input instanceof Request) return fetchImpl(input, init);
    const url = new URL(String(input));
    if (url.origin === endpointOrigin) return fetchImpl(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return fetchImpl(input, init);
    try {
      // Cap the first attempt: an unroutable host otherwise burns the full
      // connect timeout before the fallback gets a chance.
      return await fetchImpl(input, {
        ...init,
        signal: combineSignals(init?.signal ?? undefined, AbortSignal.timeout(4_000)),
      });
    } catch {
      init?.signal?.throwIfAborted();
      return fetchImpl(new URL(url.pathname + url.search, endpointOrigin), sanitizedInit(init));
    }
  };
}

/** Whether a configured stdio command is on the deployment's exact allowlist. */
export function isAllowedStdioCommand(command: string, allowed: readonly string[]): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && allowed.includes(trimmed);
}

/** The deployment's stdio settings, as MCP_STDIO_ENABLED and MCP_STDIO_ALLOWED_COMMANDS set them. */
export type McpStdioPolicy = { stdioEnabled?: boolean; allowedCommands?: readonly string[] };

export function mcpStdioAvailable(policy: McpStdioPolicy): boolean {
  return policy.stdioEnabled === true && (policy.allowedCommands?.length ?? 0) > 0;
}

const PACKAGE_RUNNER_REFUSAL = "Only npx can launch packages here";

/** Why this deployment can't run a stdio server with `command`, or undefined when it can. */
export function mcpStdioRefusal(command: string, policy: McpStdioPolicy): string | undefined {
  if (!mcpStdioAvailable(policy)) return "Stdio MCP servers aren't available here";
  if (!isAllowedStdioCommand(command, policy.allowedCommands ?? []))
    return "This stdio command isn't allowed here";
  if (isPackageRunnerCommand(command)) return PACKAGE_RUNNER_REFUSAL;
  return undefined;
}

function stdioParams(options: McpStdioOptions): StdioServerParameters {
  if (!isAllowedStdioCommand(options.command, options.allowedCommands)) {
    throw new Error("MCP stdio command is not in the configured allowlist");
  }
  if (isPackageRunnerCommand(options.command)) throw new Error(PACKAGE_RUNNER_REFUSAL);
  if (options.installedBin !== undefined && !isInstalledMcpBin(options.installedBin)) {
    throw new Error("MCP stdio bin was not installed by Ork");
  }
  if (options.installedBin === undefined && isNpxCommand(options.command)) {
    throw new Error("npx only launches a package bin Ork installed");
  }
  const command = options.installedBin?.binPath ?? options.command.trim();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = value;
  }
  return {
    command,
    args: options.args ?? [],
    cwd: options.cwd,
    env,
    stderr: "pipe",
    maxBufferSize: options.maxBufferSize,
  };
}

type CatalogRead = { result: McpDiscoveryResult<Tool>; expiresAt?: number };
type PendingCatalogRead = {
  controller: AbortController;
  callers: number;
  settled: boolean;
  promise: Promise<CatalogRead>;
};

/** A narrow seam around the official SDK, suitable for the agent tool layer. */
export class McpSession {
  client: Client;
  private readonly clientOptions: McpClientOptions;
  private transport?: Transport;
  private remoteFetch?: SafeRemoteFetch;
  private connected = false;
  private correlated = false;
  private exclusiveCall?: ReturnType<typeof mcpCallScope.getStore>;
  private readonly formControllers = new Set<AbortController>();
  private connecting?: Promise<void>;
  private catalogGeneration = 0;
  private readonly catalogReads = new Map<string, PendingCatalogRead>();
  private catalog?: { limitsKey: string; result: McpDiscoveryResult<Tool>; expiresAt?: number };

  constructor(options: McpClientOptions = {}) {
    this.clientOptions = options;
    this.client = this.newClient();
  }

  private newClient(): Client {
    const client = createMcpClient(
      { name: this.clientOptions.name ?? "orkbot", version: this.clientOptions.version ?? "0.1.0" },
      {
        ...this.clientOptions.capabilities,
        capabilities: {
          ...this.clientOptions.capabilities?.capabilities,
          elicitation: { form: {} },
        },
      },
      this.clientOptions.name,
    );
    installMcpFormHandler(client, () => this.exclusiveCall, this.formControllers);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.invalidateToolCatalog();
    });
    client.onclose = () => {
      if (this.client === client) {
        this.connected = false;
        for (const controller of this.formControllers) controller.abort();
        this.invalidateToolCatalog();
      }
    };
    return client;
  }

  get requiresIsolatedElicitation(): boolean {
    return !this.correlated;
  }

  get connectionClosed(): boolean {
    return !this.connected;
  }

  /** Credentials may change while the SDK keeps the same transport alive. */
  invalidateToolCatalog(): void {
    this.catalogGeneration += 1;
    this.catalog = undefined;
  }

  /** Stop new operations while already running tool calls finish before close. */
  retire(): void {
    this.connected = false;
    this.invalidateToolCatalog();
  }

  async connectRemote(
    options: McpRemoteOptions,
  ): Promise<{ transport: McpRemoteTransport; usedFallback: boolean }> {
    if (this.connected || this.connecting)
      throw new Error("MCP session is already connected or connecting");
    this.invalidateToolCatalog();
    const url = validateUrl(options.url, options.urlPolicy);
    const safeFetch = secureFetch(
      url,
      options.urlPolicy ?? {},
      options.headerPolicy,
      options.network,
    );
    this.remoteFetch = safeFetch;
    const originFetch = withEndpointOriginFallback(url.origin, safeFetch);
    const fetch = options.authProvider?.wrapFetch?.(originFetch) ?? originFetch;
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    let usedFallback = false;
    const connect = async (kind: McpRemoteTransport): Promise<void> => {
      const requestInit: RequestInit = { headers: options.headerPolicy?.headers };
      const transport =
        kind === "streamable-http"
          ? new StreamableHTTPClientTransport(url, {
              fetch,
              requestInit,
              authProvider: options.authProvider,
            })
          : new SSEClientTransport(url, {
              fetch,
              requestInit,
              authProvider: options.authProvider,
              eventSourceInit: { fetch: fetch as never },
            });
      this.transport = transport;
      this.correlated = kind === "streamable-http";
      await this.client.connect(transport, { signal, timeout: options.timeoutMs ?? 15_000 });
      this.connected = true;
    };
    this.connecting = (async () => {
      try {
        await connect(options.transport ?? "streamable-http");
      } catch (error) {
        const canFallback =
          (options.fallbackToSse ?? true) &&
          options.allowLegacySse &&
          (options.transport ?? "streamable-http") === "streamable-http";
        await closeMcpResource(() => this.client.close());
        this.connected = false;
        this.transport = undefined;
        if (!canFallback) {
          if (this.remoteFetch) {
            const remoteFetch = this.remoteFetch;
            await closeMcpResource(() => remoteFetch.close());
          }
          this.remoteFetch = undefined;
          throw error;
        }
        usedFallback = true;
        // The SDK's documented fallback uses a fresh Client after a failed
        // Streamable HTTP handshake; a Client cannot be reconnected safely.
        this.client = this.newClient();
        try {
          await connect("sse");
        } catch (fallbackError) {
          await this.close();
          throw fallbackError;
        }
      } finally {
        this.connecting = undefined;
      }
    })();
    await this.connecting;
    return {
      transport: usedFallback ? "sse" : (options.transport ?? "streamable-http"),
      usedFallback,
    };
  }

  async connectStdio(options: McpStdioOptions): Promise<void> {
    if (this.connected || this.connecting)
      throw new Error("MCP session is already connected or connecting");
    this.invalidateToolCatalog();
    const transport = new StdioClientTransport(stdioParams(options));
    this.transport = transport;
    // Always drain stderr: an unread pipe fills up and blocks a chatty server. The tail
    // explains a launch that fails ("not found", a crash) instead of a bare timeout.
    const stderr = new StderrTail();
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const signal = combineSignals(options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000));
    this.connecting = this.client
      .connect(transport, { signal, timeout: options.timeoutMs ?? 15_000 })
      .then(() => {
        this.connected = true;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    try {
      await this.connecting;
    } catch (error) {
      // Let the last stderr chunks of an exited process reach the buffer.
      await new Promise((done) => setImmediate(done));
      throw new McpStdioLaunchError(error, stderr.toString());
    }
  }

  async listTools(options?: {
    signal?: AbortSignal;
    discoveryLimits?: Partial<McpDiscoveryLimits>;
    /** Explicit connection diagnostics must reach the server and replace stale discovery. */
    fresh?: boolean;
  }): Promise<McpDiscoveryResult<Tool>> {
    const limits = mcpDiscoveryLimits(options?.discoveryLimits);
    const limitsKey = JSON.stringify(limits);
    if (options?.fresh) this.invalidateToolCatalog();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertConnected();
      options?.signal?.throwIfAborted();
      if (
        this.catalog?.limitsKey === limitsKey &&
        (this.catalog.expiresAt === undefined || Date.now() < this.catalog.expiresAt)
      )
        return structuredClone(this.catalog.result);
      const generation = this.catalogGeneration;
      const { result, expiresAt } = await this.sharedCatalogRead(
        `${generation}:${limitsKey}`,
        limits,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      this.assertConnected();
      // Repeat an overtaken read once; a continuously changing catalog is retryable.
      if (generation !== this.catalogGeneration) continue;
      if (!result.diagnostic)
        this.catalog = { limitsKey, result: structuredClone(result), expiresAt };
      return structuredClone(result);
    }
    throw new Error("MCP tool catalog changed repeatedly during discovery; retry discovery");
  }

  private sharedCatalogRead(
    key: string,
    limits: McpDiscoveryLimits,
    signal?: AbortSignal,
  ): Promise<CatalogRead> {
    let pending = this.catalogReads.get(key);
    if (!pending) {
      const controller = new AbortController();
      const read: PendingCatalogRead = {
        controller,
        callers: 0,
        settled: false,
        promise: this.readCatalog(limits, controller.signal),
      };
      pending = read;
      this.catalogReads.set(key, read);
      const settled = () => {
        read.settled = true;
        if (this.catalogReads.get(key) === read) this.catalogReads.delete(key);
      };
      void read.promise.then(settled, settled);
    }
    const read = pending;
    read.callers += 1;
    // Each caller stops waiting independently. Only the final caller may cancel
    // the SDK request, and a later caller then starts its own fresh read.
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", aborted);
        read.callers -= 1;
        if (read.callers === 0 && !read.settled) {
          if (this.catalogReads.get(key) === read) this.catalogReads.delete(key);
          read.controller.abort();
        }
        settle();
      };
      const aborted = () =>
        finish(() => reject(signal?.reason ?? new Error("MCP discovery cancelled")));
      signal?.addEventListener("abort", aborted, { once: true });
      void read.promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (signal?.aborted) aborted();
    });
  }

  private async readCatalog(limits: McpDiscoveryLimits, signal: AbortSignal): Promise<CatalogRead> {
    const client = this.client;
    let expiresAt: number | undefined;
    const result = await listMcpTools(
      {
        listTools: async (params, requestOptions) => {
          const startedAt = Date.now();
          const page = await client.listTools(params, requestOptions);
          // ttlMs is an optional compatibility extension preserved by the SDK.
          // Use the earliest expiry across pages, including network delay.
          for (const ttl of [page.ttlMs, page._meta?.ttlMs]) {
            if (typeof ttl === "number" && Number.isFinite(ttl) && ttl >= 0)
              expiresAt = Math.min(expiresAt ?? Infinity, startedAt + ttl);
          }
          return page;
        },
      },
      { signal },
      limits,
    );
    signal.throwIfAborted();
    return { result, expiresAt };
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options?: { signal?: AbortSignal; form?: McpFormCallOptions },
  ): Promise<CallToolResult> {
    this.assertConnected();
    if (this.clientOptions.isolatedElicitation && this.exclusiveCall)
      throw new Error("Isolated MCP session is already in use");
    const callClient = this.clientOptions.isolatedElicitation
      ? {
          callTool: (...args: Parameters<Client["callTool"]>) => {
            this.exclusiveCall = mcpCallScope.getStore();
            return this.client.callTool(...args);
          },
        }
      : this.client;
    try {
      const result = (await callMcpToolWithDeadline(
        callClient,
        name,
        args,
        options?.signal,
        options?.form,
      )) as CallToolResult;
      // Some servers report missing tools as an ordinary error result.
      if (result.isError) this.invalidateToolCatalog();
      return result;
    } catch (error) {
      // This includes unknown-tool protocol errors. Invalidate conservatively:
      // error messages are server-defined, and tool calls must never be replayed
      // just to refresh discovery.
      this.invalidateToolCatalog();
      throw error;
    } finally {
      this.exclusiveCall = undefined;
    }
  }

  /** `afterClose` follows actual SDK shutdown, even if this call stops waiting. */
  async close(afterClose?: () => Promise<void>): Promise<void> {
    this.connecting = undefined;
    for (const controller of this.formControllers) controller.abort();
    this.connected = false;
    this.invalidateToolCatalog();
    const client = this.client;
    const remoteFetch = this.remoteFetch;
    this.remoteFetch = undefined;
    this.transport = undefined;
    await closeMcpResource(() =>
      Promise.resolve()
        .then(() => client.close())
        .finally(afterClose),
    );
    if (remoteFetch) await closeMcpResource(() => remoteFetch.close());
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error("MCP session is not connected");
  }
}

export { validateUrl };
