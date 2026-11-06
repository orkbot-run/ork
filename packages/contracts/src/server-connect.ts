// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isPrivateNetworkHost } from "./network-host.js";

/** Connection links identify a server; they never authorize a session or a directory write. */
function serverOrigin(input: string): string | null {
  try {
    if (input.length > 2048 || /[\s\\]/.test(input)) return null;
    const url = new URL(input);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isPrivateNetworkHost(url.hostname))) ||
      (input !== url.origin && input !== `${url.origin}/`)
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createServerConnectLink(origin: string): string {
  const server = serverOrigin(origin);
  if (!server) throw new Error("Invalid server address.");
  const link = new URL("orkbot://connect");
  link.searchParams.set("server", server);
  return link.href;
}

export function parseServerConnectLink(input: string): string | null {
  try {
    if (input.length > 4096 || /[\s\\]/.test(input)) return null;
    const link = new URL(input);
    if (
      link.protocol !== "orkbot:" ||
      link.hostname !== "connect" ||
      link.port ||
      link.username ||
      link.password ||
      link.pathname ||
      link.hash ||
      [...link.searchParams.keys()].length !== 1 ||
      !link.searchParams.has("server")
    )
      return null;
    return serverOrigin(link.searchParams.get("server")!);
  } catch {
    return null;
  }
}
