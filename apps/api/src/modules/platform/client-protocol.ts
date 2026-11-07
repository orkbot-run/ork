// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ProtocolRange } from "@orkbot/contracts";
import {
  CLIENT_PROTOCOL_HEADER,
  CLIENT_UPDATE_REQUIRED,
  CLIENT_UPDATE_REQUIRED_STATUS,
  parseClientProtocolHeader,
  SERVER_PROTOCOL_RANGE,
  supportsProtocolVersion,
} from "@orkbot/contracts";
import type { MiddlewareHandler } from "hono";

/** Version RPC requests independently of the deployment's optional minimum-build policy. */
export function clientProtocolMiddleware(
  supported: Readonly<ProtocolRange> = SERVER_PROTOCOL_RANGE,
): MiddlewareHandler {
  return async (c, next) => {
    const version = parseClientProtocolHeader(c.req.header(CLIENT_PROTOCOL_HEADER));
    if (version === null || !supportsProtocolVersion(supported, version)) {
      const status = version === null ? 400 : CLIENT_UPDATE_REQUIRED_STATUS;
      return c.json(
        {
          json: {
            defined: false,
            code: version === null ? "BAD_REQUEST" : CLIENT_UPDATE_REQUIRED,
            status,
            message: version === null ? "Invalid client protocol" : "Update required",
          },
        },
        status,
        { "cache-control": "no-store" },
      );
    }
    await next();
  };
}
