// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const routerRequire = createRequire(require.resolve("expo-router/package.json"));
const queryString = routerRequire("query-string") as {
  parse: (query: string) => Record<string, unknown>;
  stringify: (query: Record<string, string | string[]>) => string;
};

describe("mobile routing query strings", () => {
  it("decodes Unicode, repeated parameters, and empty values through the router's parser", () => {
    expect(queryString.parse("name=za%C5%BC%C3%B3%C5%82%C4%87&tag=a&tag=b&empty=&flag")).toEqual({
      name: "zażółć",
      tag: ["a", "b"],
      empty: "",
      flag: null,
    });
  });

  it("keeps malformed escape sequences readable", () => {
    expect(queryString.parse("value=%st%C3%A5le%")).toEqual({ value: "%ståle%" });
  });

  it("round-trips Unicode and repeated parameters", () => {
    const query = { name: "zażółć", tag: ["a", "b"] };
    expect(queryString.parse(queryString.stringify(query))).toEqual(query);
  });
});
