// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RequestListener } from "node:http";
import { getRequestListener } from "@hono/node-server";

/** The inner TLS socket must not change a loopback installation's logical HTTP origin. */
export function installationHttpListener(
  origin: string,
  fetch: Parameters<typeof getRequestListener>[0],
): RequestListener {
  const listener = getRequestListener(fetch);
  return (request, response) => {
    request.url = new URL(request.url!, origin).href;
    return listener(request, response);
  };
}
