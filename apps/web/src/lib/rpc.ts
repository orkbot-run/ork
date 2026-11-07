// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material; native revocation retry integration is PolyForm-covered. See LICENSE.md.

import { createRpcLink } from "@orkbot/client-transport";
import type { AiConsentStatus, AppContract, ProductEvent } from "@orkbot/contracts";
import {
  CLIENT_BUILD_HEADER,
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_VERSION,
  formatClientBuild,
} from "@orkbot/contracts";
import {
  AiConsentBlocked,
  aiConsentTarget,
  aiDataUsesForProcedure,
  cancelResponseBody,
  displayIdentityEvent,
  displayIdentityResult,
  ensureAiDataConsent,
} from "@orkbot/core";
import { clientCorrelationHeaders, responseCorrelation } from "@orkbot/logging/monitoring";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { cancelAiConsentPrompts, promptAiConsent } from "./ai-consent";
import { authClient } from "./auth";
import { isLeavingSession, sessionChangedUnderPage } from "./call-session";
import { CLIENT_BUILD } from "./client-build";
import { desktopBridge } from "./desktop";
import { i18n } from "./i18n";
import { identityLabels } from "./identity-display";
import { reportClientError } from "./monitoring";

const SPACE_STORAGE_KEY = "orkbot:space-id";
export const ORGANIZATION_SPACES_STORAGE_KEY = "orkbot:org-spaces";

let spaceSelectionGeneration = 0;

type RpcClientContext = { spaceId?: string | null; isCurrent?: () => boolean };

export function selectedSpaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Fired after the selected Space changes, so per-organization state (billing) can reload. */
export const SPACE_SELECTED_EVENT = "orkbot:space-selected";

export function selectSpace(id: string): boolean {
  let selected: boolean;
  try {
    window.localStorage.setItem(SPACE_STORAGE_KEY, id);
    selected = true;
  } catch {
    try {
      // Write failed but the desired selection is already durable — treat as success.
      selected = window.localStorage.getItem(SPACE_STORAGE_KEY) === id;
    } catch {
      selected = false;
    }
  }
  if (selected) {
    spaceSelectionGeneration += 1;
    cancelAiConsentPrompts();
    window.dispatchEvent(new Event(SPACE_SELECTED_EVENT));
  }
  return selected;
}

export function clearSpaceSelection(): void {
  spaceSelectionGeneration += 1;
  cancelAiConsentPrompts();
  try {
    window.localStorage.removeItem(SPACE_STORAGE_KEY);
    window.localStorage.removeItem(ORGANIZATION_SPACES_STORAGE_KEY);
  } catch {
    // Ignore storage failures on sign-out / reset paths.
  }
}

/** Adds `x-orkbot-space-id` when a space is selected. */
export function withSpaceHeaders(
  init?: HeadersInit,
  spaceId: string | null = selectedSpaceId(),
): Headers {
  const headers = new Headers(init);
  if (spaceId) headers.set("x-orkbot-space-id", spaceId);
  else headers.delete("x-orkbot-space-id");
  return headers;
}

const responseListeners = new Set<(response: Response) => void>();

/** Every API reply, for the build handshake; RPC callers still get their own result. */
export function onRpcResponse(listener: (response: Response) => void): () => void {
  responseListeners.add(listener);
  return () => {
    responseListeners.delete(listener);
  };
}

const link = createRpcLink<RpcClientContext>({
  url: () =>
    typeof window === "undefined" ? "http://127.0.0.1:5173/rpc" : `${window.location.origin}/rpc`,
  headers: (options) => {
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const correlation = clientCorrelationHeaders();
    const headers = withSpaceHeaders(undefined, spaceId);
    headers.set(CLIENT_PROTOCOL_HEADER, String(CLIENT_PROTOCOL_VERSION));
    if (CLIENT_BUILD) headers.set(CLIENT_BUILD_HEADER, formatClientBuild("web", CLIENT_BUILD));
    for (const [key, value] of Object.entries(correlation)) headers.set(key, value);
    return headers;
  },
  fetch: async (input, init, options) => {
    const assertCurrent = (response?: Response) => {
      if (options.context.isCurrent && !options.context.isCurrent()) {
        if (response) cancelResponseBody(response);
        throw new DOMException("Session changed", "AbortError");
      }
    };
    assertCurrent();
    const request = new Request(input, init);
    const spaceId = request.headers.get("x-orkbot-space-id");
    let response: Response;
    try {
      response = await fetch(request, {
        ...init,
        credentials: "include",
        // Keep cancellation attached directly to fetch rather than only a cloned Request.
        signal: options.signal,
      });
    } catch (error) {
      assertCurrent();
      if (!options.signal?.aborted)
        reportClientError(error, "rpc.transport", responseCorrelation(request.headers));
      throw error;
    }
    assertCurrent(response);
    // Server exceptions are reported by the API; do not report every HTTP failure twice.
    recheckSessionOnUnauthorized(response.status);
    if (response.status === 401 && spaceId && spaceId === selectedSpaceId())
      void leaveUnavailableSpace(spaceId, options.context.isCurrent);
    return response;
  },
  onResponse: (response, call) => {
    const current = () => !call.context.isCurrent || call.context.isCurrent();
    if (!current()) throw new DOMException("Session changed", "AbortError");
    if (response.ok)
      void Promise.resolve()
        .then(() => (current() ? desktopBridge()?.accounts?.retryRevocations?.() : undefined))
        .catch(() => undefined);
    for (const listener of responseListeners) {
      if (!current()) break;
      listener(response);
    }
  },
});

/**
 * A 401 means the session behind the app's last known user may be gone, but Better Auth only
 * rechecks it on focus or a timer, so a backgrounded window would keep its stale user (and every
 * screen that polls) indefinitely. Recheck now: a signed-out answer routes to sign-in.
 */
export function recheckSessionOnUnauthorized(status: number): void {
  if (status === 401) authClient.$store.notify("$sessionSignal");
}

let leavingSpace: Promise<void> | null = null;

/**
 * The server answers 401 when the selected space is no longer one of the user's, for instance
 * after they are removed from it, and every request would keep failing. Ask without a space which
 * spaces the user has in any organization; if the selected one is not among them, reload into
 * their default space.
 */
export function leaveUnavailableSpace(spaceId: string, isCurrent?: () => boolean): Promise<void> {
  if (isCurrent && !isCurrent()) return Promise.resolve();
  leavingSpace ??= (async () => {
    try {
      const { organizations } = await rpc.organizations.list(undefined, {
        context: { spaceId: null, ...(isCurrent ? { isCurrent } : {}) },
      });
      if (
        (isCurrent && !isCurrent()) ||
        organizations.some((organization) => organization.spaceIds.includes(spaceId)) ||
        selectedSpaceId() !== spaceId
      )
        return;
      try {
        window.localStorage.removeItem(SPACE_STORAGE_KEY);
      } catch {
        // Without storage the reload keeps asking without a Space.
      }
      window.location.reload();
    } catch {
      // Signed out or unreachable: leave the selection for the next request to try again.
    } finally {
      leavingSpace = null;
    }
  })();
  return leavingSpace;
}

export type RpcClient = ContractRouterClient<AppContract, RpcClientContext>;

const displayLink = {
  call: async (...args: Parameters<typeof link.call>) => {
    const [path, input, options] = args;
    const uses = aiDataUsesForProcedure(path.join("/"), input);
    const target = aiConsentTarget(input);
    const spaceId =
      options.context.spaceId === undefined ? selectedSpaceId() : options.context.spaceId;
    const generation = spaceSelectionGeneration;
    const session = () =>
      authClient.$store.atoms.session?.get().data?.session?.id as string | undefined;
    const identity = uses.length ? session() : undefined;
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const assertContext = () => {
      if (
        !identity ||
        session() !== identity ||
        generation !== spaceSelectionGeneration ||
        origin !== window.location.origin ||
        isLeavingSession() ||
        sessionChangedUnderPage()
      )
        throw new AiConsentBlocked();
    };
    const boundOptions = { ...options, context: { ...options.context, spaceId } };
    if (uses.length) {
      assertContext();
      await ensureAiDataConsent({
        uses,
        coalesceKey: JSON.stringify([origin, identity, generation, spaceId]),
        status: async () => {
          const status = (await link.call(
            ["aiConsent", "status"],
            { ...target, uses },
            boundOptions,
          )) as AiConsentStatus;
          assertContext();
          return status;
        },
        prompt: async (recipient, privacyUrl) => {
          assertContext();
          const answer = await promptAiConsent(recipient, privacyUrl);
          assertContext();
          return answer;
        },
        allow: (grant) => {
          assertContext();
          return link.call(["aiConsent", "allow"], { ...target, ...grant }, boundOptions);
        },
      });
      assertContext();
    }
    const result = await link.call(path, input, uses.length ? boundOptions : options);
    if (path.join("/") === "threads/subscribe") {
      return (async function* () {
        for await (const event of result as AsyncIterable<ProductEvent>) {
          yield displayIdentityEvent(event, identityLabels());
        }
      })();
    }
    // Bootstrap can be prefetched before the locale catalog is ready. Its consumer projects it.
    return i18n.locale ? displayIdentityResult(path, result, identityLabels()) : result;
  },
};

export const rpc: RpcClient = createORPCClient(displayLink);

/** A multi-step native-renderer intent keeps its original session, server and Space. */
export function captureRpcContext(spaceId = selectedSpaceId()) {
  const identity = authClient.$store.atoms.session?.get().data?.session?.id;
  const generation = spaceSelectionGeneration;
  const origin = window.location.origin;
  const isCurrent = () =>
    Boolean(
      identity &&
        identity === authClient.$store.atoms.session?.get().data?.session?.id &&
        generation === spaceSelectionGeneration &&
        origin === window.location.origin &&
        !isLeavingSession() &&
        !sessionChangedUnderPage(),
    );
  const client: RpcClient = createORPCClient({
    call: async (path, input, options) => {
      if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
      try {
        const result = await displayLink.call(path, input, {
          ...options,
          context: { ...options.context, spaceId, isCurrent },
        });
        if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
        return result;
      } catch (error) {
        if (!isCurrent()) throw new DOMException("Session changed", "AbortError");
        throw error;
      }
    },
  });
  return { client, isCurrent };
}

/** Keep late async follow-up requests in the shell's original auth boundary. */
export function createSpaceRpc(spaceId: string | null): typeof rpc {
  return createORPCClient({
    call: (path, input, options) =>
      displayLink.call(path, input, {
        ...options,
        // A call that names its own space (e.g. renaming another space's section) keeps it.
        context: {
          ...options.context,
          spaceId: options.context.spaceId === undefined ? spaceId : options.context.spaceId,
        },
      }),
  });
}

const spaceClients = new Map<string, RpcClient>();

/** Reuse a client for settings without changing the selected space. */
export function rpcForSpace(spaceId: string): RpcClient {
  let client = spaceClients.get(spaceId);
  if (!client) {
    client = createSpaceRpc(spaceId);
    spaceClients.set(spaceId, client);
  }
  return client;
}
