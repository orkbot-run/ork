// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited screen URL handling is preserved. Native viewer selection follows LICENSE.md.

import { t } from "@lingui/core/macro";
import { isLocalhostOrLoopbackIp } from "@orkbot/contracts";
import { COMPUTER_SCREEN_PATH } from "@orkbot/contracts/content-security-policy";
import { COMPUTER_FRAME_SOURCE } from "@orkbot/core";
import { errorText } from "./user-error";

export interface ComputerScreenResult {
  url: string | null;
  error: string | null;
}

/** Only the latest request for the visible computer may replace its screen or error. */
export async function loadComputerScreen(options: {
  load: () => Promise<{ url: string | null }>;
  isCurrent: () => boolean;
  commit: (result: ComputerScreenResult) => void;
  fallbackError: string;
}): Promise<string | null> {
  let result: ComputerScreenResult;
  try {
    const screen = await options.load();
    result = { url: screen.url, error: null };
  } catch (error) {
    result = {
      url: null,
      error: errorText(error, options.fallbackError),
    };
  }
  if (!options.isCurrent()) return null;
  options.commit(result);
  return result.url;
}

export function embeddableScreenUrl(url: string | null): string | null {
  if (!url) return null;
  if (url === COMPUTER_FRAME_SOURCE) return url;
  const location = screenLocation(url);
  if (!location) return null;
  const { target, page } = location;
  if (target.username || target.password) return null;
  // The SDK needs the one-time code in the fragment so it stays out of server logs.
  if (
    (target.protocol === "wuying:" || target.protocol === "embedded-screen:") &&
    target.hostname === "desktop"
  ) {
    return `${page.origin}${COMPUTER_SCREEN_PATH}#${target.searchParams.toString()}`;
  }
  if (!isHttpUrl(target)) return null;
  // WEB_ORIGIN can name a different loopback host than the renderer.
  if (target.pathname.startsWith("/novnc/")) {
    return `${page.origin}${target.pathname}${target.search}${target.hash}`;
  }
  if (target.origin === page.origin && !isProxyScreenPath(target.pathname)) return null;
  const pagePort = page.port || (page.protocol === "https:" ? "443" : "80");
  if (isLocalhostOrLoopbackIp(target.hostname) && target.port && target.port !== pagePort)
    return null;
  return target.toString();
}

/**
 * An embedded screen URL carries a one-time login code, so every read of it differs. Reloading the
 * frame for a new code would open a second session that signs the first one out; the screen keeps
 * the URL it connected with until the desktop or the view changes.
 */
export function sameEmbeddedComputerScreen(current: string | null, next: string | null): boolean {
  if (!current || !next) return false;
  try {
    const a = new URL(current);
    const b = new URL(next);
    if (a.protocol === "http:" || a.protocol === "https:" || a.protocol !== b.protocol)
      return false;
    return ["desktop_id", "region_id", "view_only"].every(
      (name) => a.searchParams.get(name) === b.searchParams.get(name),
    );
  } catch {
    return false;
  }
}

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function screenLocation(url: string) {
  const href = pageLocationHref();
  if (!href) return null;
  try {
    const page = new URL(href);
    return isHttpUrl(page) ? { page, target: new URL(url, page) } : null;
  } catch {
    return null;
  }
}

function isProxyScreenPath(pathname: string): boolean {
  return pathname.startsWith("/novnc/") || pathname === COMPUTER_SCREEN_PATH;
}

/** Each iframe has a sandbox. Only a remote HTTP(S) screen may keep its own origin. */
export function screenIframeSandbox(url: string | null): string {
  const location = url ? screenLocation(url) : null;
  if (!location) return "";
  const { target, page } = location;
  if (!isHttpUrl(target) || target.username || target.password) return "";
  if (target.origin !== page.origin) return "allow-scripts allow-same-origin allow-pointer-lock";
  return isProxyScreenPath(target.pathname) ? "allow-scripts allow-pointer-lock" : "";
}

/** Deduplicate only the boot request; callers can still take over and refresh. */
export async function bootComputerOnce<T>(
  inFlight: Map<string, symbol>,
  botId: string,
  boot: () => Promise<T>,
): Promise<T | undefined> {
  if (inFlight.has(botId)) return;
  const token = Symbol(botId);
  inFlight.set(botId, token);
  try {
    return await boot();
  } finally {
    if (inFlight.get(botId) === token) inFlight.delete(botId);
  }
}

/** Only pages the web proxy serves carry the shim that reports their state to the app. */
export function isProxiedScreenUrl(url: string | null): url is string {
  const location = url ? screenLocation(url) : null;
  return Boolean(
    location &&
      isHttpUrl(location.target) &&
      !location.target.username &&
      !location.target.password &&
      location.target.origin === location.page.origin &&
      isProxyScreenPath(location.target.pathname),
  );
}

/** How long a framed screen may stay silent before the app treats it as not loaded. */
export const SCREEN_FRAME_LOAD_TIMEOUT_MS = 15_000;

export type ScreenFrameState = "loading" | "connecting" | "connected" | "failed" | "disconnected";

export interface ScreenFrameMessage {
  orkbotScreen: ScreenFrameState;
  detail?: string;
}

const SCREEN_FRAME_STATES: ReadonlySet<string> = new Set<ScreenFrameState>([
  "loading",
  "connecting",
  "connected",
  "failed",
  "disconnected",
]);

/** A state report posted by a framed screen page, or null for any other message. */
export function screenFrameMessage(data: unknown): ScreenFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const { orkbotScreen, detail } = data as Record<string, unknown>;
  if (typeof orkbotScreen !== "string" || !SCREEN_FRAME_STATES.has(orkbotScreen)) return null;
  const text = typeof detail === "string" ? detail.trim().slice(0, 200) : "";
  return { orkbotScreen: orkbotScreen as ScreenFrameState, ...(text ? { detail: text } : {}) };
}

/** Whether a report shows the page got past loading; a page stalled there is still silent. */
export function screenFrameStarted(message: ScreenFrameMessage): boolean {
  return message.orkbotScreen !== "loading";
}

/** The error a frame report means for the screen, or null while it is fine. */
export function screenFrameError(message: ScreenFrameMessage, fallback: string): string | null {
  if (message.orkbotScreen !== "failed" && message.orkbotScreen !== "disconnected") return null;
  return message.orkbotScreen === "disconnected" ? t`The screen connection closed.` : fallback;
}

/**
 * Cookies a screen probe may attach. The capability in the URL authorizes the screen, so a host
 * that is not this page never receives the session cookie. A same-origin http(s) probe includes
 * it: an identity-aware proxy in front of this app answers a cookie-less request with a redirect,
 * and `redirect: "manual"` hides that as an opaque redirect the probe would treat as a failed
 * screen. Other schemes, such as an embedded screen ticket, stay cookie-less.
 */
function screenProbeCredentials(url: string): RequestCredentials {
  const pageHref = pageLocationHref();
  if (!pageHref) return "omit";
  try {
    const target = new URL(url, pageHref);
    if (target.protocol !== "http:" && target.protocol !== "https:") return "omit";
    return target.origin === new URL(pageHref).origin ? "same-origin" : "omit";
  } catch {
    return "omit";
  }
}

function pageLocationHref(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const href = window.location?.href;
  return typeof href === "string" ? href : undefined;
}

/**
 * Ask the proxy for the page before framing it. A frame cannot say why it failed to load, so a
 * refused or unreachable screen would otherwise stay blank.
 */
export async function probeScreen(
  url: string,
  fallback: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(url, {
      credentials: screenProbeCredentials(url),
      cache: "no-store",
      redirect: "manual",
    });
    if (response.ok) return null;
    // The proxy couldn't reach the API to check the screen: that's a connection problem.
    if (response.type === "opaqueredirect" || response.status === 503) return fallback;
    if (response.status === 403) return t`The screen link expired.`;
    const body = await response.text().catch(() => "");
    if (response.status === 502 && body.trim() === "Screen unavailable (upstream_timeout)") {
      return t`The screen did not respond.`;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * The screen page's status through the proxy's access check, or null if it couldn't be asked.
 * Only the status is read; the body is dropped unread.
 */
export async function probeScreenStatus(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const response = await fetchImpl(url, {
      credentials: screenProbeCredentials(url),
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    void response.body?.cancel().catch(() => undefined);
    return response.type === "opaqueredirect" ? 0 : response.status;
  } catch {
    return null;
  }
}

/**
 * Whether a reconnected screen takes the keyboard back: only a screen that had it when it
 * dropped, and only if the user hasn't moved on. Focus anywhere else in the app, or the screen
 * failing, forgets it, and it happens at most once per drop.
 */
export function createScreenRefocus() {
  let pending = false;
  return {
    dropped(hadFocus: boolean) {
      pending = hadFocus;
    },
    forget() {
      pending = false;
    },
    /** On a reconnected screen's "connected": whether to give it the keyboard now. */
    connected(active: Element | null, frame: Element, body: Element | null): boolean {
      if (!pending) return false;
      pending = false;
      return !active || active === body || active === frame;
    },
  };
}
