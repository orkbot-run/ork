// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";
import protocolVersion from "./client-protocol-version.json" with { type: "json" };

export const CLIENT_PROTOCOL_HEADER = "x-orkbot-protocol";
export const CLIENT_PROTOCOL_VERSION = protocolVersion;

const protocolVersionSchema = z.number().int().positive();

export const protocolRangeSchema = z
  .object({ min: protocolVersionSchema, max: protocolVersionSchema })
  .strict()
  .refine((range) => range.min <= range.max, { message: "Invalid protocol range" });
export type ProtocolRange = z.infer<typeof protocolRangeSchema>;

export const SERVER_PROTOCOL_RANGE: Readonly<ProtocolRange> = Object.freeze({
  min: CLIENT_PROTOCOL_VERSION,
  max: CLIENT_PROTOCOL_VERSION,
});

/** Missing discovery is the original RPC protocol; malformed discovery is never legacy. */
export function supportsProtocolVersion(
  range: unknown,
  version = CLIENT_PROTOCOL_VERSION,
): boolean {
  if (!protocolVersionSchema.safeParse(version).success) return false;
  if (range === undefined) return version === 1;
  const parsed = protocolRangeSchema.safeParse(range);
  return parsed.success && parsed.data.min <= version && version <= parsed.data.max;
}

/** Old clients omit the header. An explicit value must be one positive safe integer. */
export function parseClientProtocolHeader(header: string | null | undefined): number | null {
  if (header === undefined || header === null) return 1;
  if (!/^[1-9][0-9]*$/.test(header)) return null;
  const version = Number(header);
  return Number.isSafeInteger(version) ? version : null;
}
