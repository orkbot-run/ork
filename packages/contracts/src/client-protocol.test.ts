// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import {
  CLIENT_PROTOCOL_HEADER,
  CLIENT_PROTOCOL_VERSION,
  parseClientProtocolHeader,
  protocolRangeSchema,
  SERVER_PROTOCOL_RANGE,
  supportsProtocolVersion,
} from "./client-protocol.js";

describe("RPC protocol compatibility", () => {
  it("shares one positive safe protocol version with native clients", () => {
    expect(Number.isSafeInteger(CLIENT_PROTOCOL_VERSION)).toBe(true);
    expect(CLIENT_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(SERVER_PROTOCOL_RANGE).toEqual({
      min: CLIENT_PROTOCOL_VERSION,
      max: CLIENT_PROTOCOL_VERSION,
    });
  });

  it("advertises the implemented protocol without changing legacy version one", () => {
    expect(CLIENT_PROTOCOL_HEADER).toBe("x-orkbot-protocol");
    expect(CLIENT_PROTOCOL_VERSION).toBe(1);
    expect(protocolRangeSchema.parse(SERVER_PROTOCOL_RANGE)).toEqual({ min: 1, max: 1 });
    expect(supportsProtocolVersion(SERVER_PROTOCOL_RANGE)).toBe(true);
    expect(parseClientProtocolHeader(undefined)).toBe(1);
    expect(parseClientProtocolHeader(null)).toBe(1);
    expect(supportsProtocolVersion(undefined, 1)).toBe(true);
    expect(supportsProtocolVersion(undefined, 2)).toBe(false);
  });

  it.each(["1", "2", String(Number.MAX_SAFE_INTEGER)])("reads explicit version %s", (value) => {
    expect(parseClientProtocolHeader(value)).toBe(Number(value));
  });

  it.each([
    "",
    " ",
    " 1 ",
    "0",
    "01",
    "-1",
    "+1",
    "1.0",
    "1e0",
    "1, 2",
    "NaN",
    "Infinity",
    "9007199254740992",
  ])("never treats malformed header %j as legacy", (value) =>
    expect(parseClientProtocolHeader(value)).toBeNull(),
  );

  it.each([
    null,
    {},
    [],
    { min: 1 },
    { max: 1 },
    { min: "1", max: 1 },
    { min: 0, max: 1 },
    { min: 1, max: 0 },
    { min: -1, max: 1 },
    { min: 1, max: 1.5 },
    { min: 2, max: 1 },
    { min: 1, max: Number.POSITIVE_INFINITY },
    { min: Number.NaN, max: 1 },
    { min: 1, max: Number.MAX_SAFE_INTEGER + 1 },
    { min: 1, max: 1, preferred: 1 },
  ])("rejects malformed advertised range %j", (range) => {
    expect(protocolRangeSchema.safeParse(range).success).toBe(false);
    expect(supportsProtocolVersion(range)).toBe(false);
  });

  it("accepts only versions the server explicitly supports", () => {
    for (const version of [1, 2, 3])
      expect(supportsProtocolVersion({ min: 1, max: 3 }, version)).toBe(true);
    for (const version of [0, 0.5, 4, Number.NaN, Number.POSITIVE_INFINITY])
      expect(supportsProtocolVersion({ min: 1, max: 3 }, version)).toBe(false);
    expect(supportsProtocolVersion({ min: 2, max: 3 }, 1)).toBe(false);
  });
});
