// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import {
  createServerConnectLink,
  createServerInitializeLink,
  parseServerConnectLink,
  parseServerInitializeLink,
} from "./server-connect.js";

describe("server connection links", () => {
  it.each([
    "https://ork.example.test",
    "http://192.168.1.20:45173",
    "http://localhost:45173",
    "https://[2001:db8::1]",
  ])("round trips a server origin: %s", (origin) => {
    expect(parseServerConnectLink(createServerConnectLink(origin))).toBe(origin);
  });

  it.each([
    "http://public.example.test",
    "ftp://example.test",
    "https://user:secret@example.test",
    "https://example.test/path",
    "https://example.test?token=secret",
    "https://example.test#secret",
    "https://example.test/../",
    "https://EXAMPLE.test",
    "https://example.test\\evil",
    " https://example.test",
  ])("refuses ambiguous or unsafe origins: %s", (origin) => {
    expect(() => createServerConnectLink(origin)).toThrow();
    expect(
      parseServerConnectLink(`orkbot://connect?server=${encodeURIComponent(origin)}`),
    ).toBeNull();
  });

  it.each([
    "https://connect?server=https%3A%2F%2Fexample.test",
    "orkbot://connect/path?server=https%3A%2F%2Fexample.test",
    "orkbot://user@connect?server=https%3A%2F%2Fexample.test",
    "orkbot://connect:42?server=https%3A%2F%2Fexample.test",
    "orkbot://connect?server=https%3A%2F%2Fexample.test&server=https%3A%2F%2Fother.test",
    "orkbot://connect?server=https%3A%2F%2Fexample.test&token=secret",
    "orkbot://connect?server=https%3A%2F%2Fexample.test#token",
    "orkbot://connect",
    "orkbot://connect?server=",
    "orkbot://connect/?server=https%3A%2F%2Fexample.test",
  ])("rejects malformed links: %s", (link) => {
    expect(parseServerConnectLink(link)).toBeNull();
  });
});

describe("server initialization links", () => {
  const origin = "https://server.example.test";
  const secret = "a".repeat(43);
  it("keeps initialization separate from ordinary connection links", () => {
    const link = createServerInitializeLink(origin, secret);
    expect(parseServerInitializeLink(link)).toEqual({ server: origin, secret });
    expect(parseServerConnectLink(link)).toBeNull();
    expect(parseServerInitializeLink(createServerConnectLink(origin))).toBeNull();
  });
  it.each([
    `orkbot://initialize?server=${encodeURIComponent(origin)}&secret=${secret}&secret=${secret}`,
    `orkbot://initialize?server=${encodeURIComponent(origin)}&secret=${secret}&extra=1`,
    `orkbot://initialize/?server=${encodeURIComponent(origin)}&secret=${secret}`,
    `orkbot://initialize?server=${encodeURIComponent(origin)}&secret=short`,
    `orkbot://initialize?server=${encodeURIComponent("http://public.example.test")}&secret=${secret}`,
    `orkbot://initialize?server=${encodeURIComponent(origin)}&secret=${secret}#fragment`,
  ])("rejects ambiguous initialization credentials: %s", (link) => {
    expect(parseServerInitializeLink(link)).toBeNull();
  });
  it("rejects invalid initialization credentials at construction", () => {
    expect(() => createServerInitializeLink(origin, "short")).toThrow();
    expect(() => createServerInitializeLink("http://public.example.test", secret)).toThrow();
  });
});
