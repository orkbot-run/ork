// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 web CONNECT transport is preserved; shared extraction follows LICENSE.md.

import type { LookupFunction } from "node:net";
import type { Dispatcher } from "undici";
import { EnvHttpProxyAgent, Pool } from "undici";

/** Honor standard proxy settings while checking the destination before every CONNECT. */
export function createCheckedProxyDispatcher(
  lookup: LookupFunction,
  checkedAuthority: (authority: string) => Promise<string>,
): Dispatcher {
  const { env } = process;
  for (const proxy of [env.http_proxy ?? env.HTTP_PROXY, env.https_proxy ?? env.HTTPS_PROXY]) {
    if (proxy && !/^https?:\/\//i.test(proxy)) throw new Error("Only HTTP proxies are supported");
  }
  return new EnvHttpProxyAgent({
    connect: { lookup },
    proxyTunnel: true,
    clientFactory: (origin, options) => {
      const pool = new Pool(origin, options);
      const connect = pool.connect.bind(pool) as (
        options: Dispatcher.ConnectOptions,
      ) => Promise<Dispatcher.ConnectData>;
      return Object.assign(pool, {
        connect: async (options: Dispatcher.ConnectOptions) => {
          const authority = await checkedAuthority(options.path);
          return connect({
            ...options,
            path: authority,
            headers: { ...(options.headers as Record<string, string>), host: authority },
          });
        },
      });
    },
  });
}
