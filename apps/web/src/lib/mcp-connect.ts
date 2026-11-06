// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited OAuth completion is preserved; native popup session handling is an Ork addition.

import { supportsNativeSsoPopup } from "./desktop";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { rpc } from "./rpc";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
/** Where providers send the user back; a pre-registered client must allow it. */
export function mcpOAuthRedirectUri(): string {
  return `${window.location.origin}/mcp/oauth/callback`;
}

export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  const started = await rpc.mcp.oauth.begin({ serverId, redirectUri: mcpOAuthRedirectUri() });
  if (started.status !== "authorization_required") return started.status;
  const native = supportsNativeSsoPopup();
  const popup = window.open(
    native ? "about:blank" : started.authorizationUrl,
    MCP_OAUTH_CHANNEL,
    "popup,width=560,height=720",
  );
  if (!popup) {
    // A native product must keep its authenticated document and shared-cookie popup.
    if (!native) window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    // COOP makes an open popup read as closed, but it keeps focus until the
    // user really closes it.
    pollTimer = window.setInterval(() => {
      if (popup.closed && document.hasFocus()) finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== "mcp-oauth-complete") return;
      finish("connected");
    };
    if (native) {
      // Tauri can create a related popup only from a trusted same-origin or blank entry.
      // Subscribe first so an already authorized provider cannot outrun completion capture.
      try {
        popup.opener = null;
        popup.location.href = started.authorizationUrl;
      } catch {
        popup.close();
        finish("cancelled");
      }
    }
  });
}
