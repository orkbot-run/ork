// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { parseRetryAfter } from "@orkbot/core";
import { createORPCErrorFromJson, isORPCErrorJson, ORPCError } from "@orpc/client";
import { StandardRPCJsonSerializer, StandardRPCSerializer } from "@orpc/client/standard";

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

export type RpcJsonEnvelope = { json?: unknown; meta?: unknown };

/** Use oRPC's public serializer for the complete JSON wire format, including type metadata. */
export function encodeRpcJson(value: unknown): RpcJsonEnvelope {
  const encoded = serializer.serialize(value);
  if (
    encoded instanceof FormData ||
    (encoded && typeof encoded === "object" && Symbol.asyncIterator in encoded)
  )
    throw new TypeError("JSON RPC transport does not accept files or input streams.");
  return encoded as RpcJsonEnvelope;
}

export function decodeRpcJson(envelope: unknown): unknown {
  return serializer.deserialize(envelope as Parameters<typeof serializer.deserialize>[0]);
}

/** Preserve oRPC error identity and metadata while retaining HTTP retry advice. */
export function rpcHttpError(
  response: Response,
  envelope?: unknown,
  options: { fallbackMessage?: string } = {},
): ORPCError<string, unknown> & { retryAfterMs?: number } {
  let decoded: unknown;
  try {
    decoded = decodeRpcJson(envelope);
  } catch {
    /* A proxy may return a non-oRPC body. */
  }
  const partial =
    decoded && typeof decoded === "object"
      ? (decoded as { code?: unknown; message?: unknown; data?: unknown })
      : undefined;
  const code = typeof partial?.code === "string" ? partial.code : undefined;
  const error = isORPCErrorJson(decoded)
    ? createORPCErrorFromJson(decoded)
    : new ORPCError(code ?? "MALFORMED_ORPC_ERROR_RESPONSE", {
        status: response.status >= 400 && response.status <= 599 ? response.status : 500,
        message: typeof partial?.message === "string" ? partial.message : options.fallbackMessage,
        data: partial?.data,
      });
  return Object.assign(error, {
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
  });
}
