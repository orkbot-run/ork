// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { isPrivateNetworkHost } from "./network-host.js";

export const SERVER_INSTALL_COMMAND = "curl -fsSL https://install.ork.run | sh";

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

/** Initialization proves access to the operator's one-use bootstrap link. */
export function createServerInitializeLink(origin: string, secret: string): string {
  const server = serverOrigin(origin);
  if (!server || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new Error("Invalid server initialization link.");
  const link = new URL("orkbot://initialize");
  link.searchParams.set("server", server);
  link.searchParams.set("secret", secret);
  return link.href;
}

export function parseServerInitializeLink(
  input: string,
): { server: string; secret: string } | null {
  try {
    if (input.length > 4096 || /[\s\\]/.test(input)) return null;
    const link = new URL(input);
    const server = serverOrigin(link.searchParams.get("server") ?? "");
    const secret = link.searchParams.get("secret") ?? "";
    if (
      link.protocol !== "orkbot:" ||
      link.hostname !== "initialize" ||
      link.port ||
      link.username ||
      link.password ||
      link.pathname ||
      link.hash ||
      [...link.searchParams.keys()].length !== 2 ||
      !server ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret)
    )
      return null;
    return { server, secret };
  } catch {
    return null;
  }
}
