// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it } from "vitest";
import { createServerConnectLink, parseServerConnectLink } from "./server-connect.js";

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
