// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 history tests are preserved. Argument regression coverage is an Ork addition.

import { describe, expect, it } from "vitest";
import { HistoryReadInputSchema, HistorySearchInputSchema } from "./history.js";

describe("history date boundaries", () => {
  it.each([
    ["2026-01-01", "2026-01-01T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
    ["2026-01-01T00:00:00+02:00", "2025-12-31T22:00:00.000Z"],
    ["2026-01-01T00:00:00-05:30", "2026-01-01T05:30:00.000Z"],
  ])("normalizes %s without changing the intended instant", (input, expected) => {
    expect(
      HistorySearchInputSchema.parse({ query: "Aurora", before: input, after: input }),
    ).toMatchObject({ before: expected, after: expected });
  });
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-02-29T00:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+25:00",
    "January 1, 2026",
  ])("rejects invalid or ambiguous boundary %s", (value) => {
    for (const field of ["before", "after"])
      expect(HistorySearchInputSchema.safeParse({ query: "Aurora", [field]: value }).success).toBe(
        false,
      );
  });
});

describe("history search arguments", () => {
  it("requires a query input and normalizes variants", () => {
    expect(
      HistorySearchInputSchema.parse({ queries: [" Aurora ", "aurora", "orbit"] }).queries,
    ).toEqual(["Aurora", "orbit"]);
    for (const input of [
      {},
      { queries: [] },
      { queries: [" "] },
      { queries: Array(6).fill("a") },
      { query: "a", scope: "all" },
      { query: "a", kinds: ["secret_prompt"] },
      { query: "a", offset: -1 },
    ])
      expect(HistorySearchInputSchema.safeParse(input).success).toBe(false);
  });

  it("folds both query inputs with the single query first without changing the input", () => {
    const input = { query: " Aurora ", queries: ["orbit", "aurora"] };
    expect(HistorySearchInputSchema.parse(input)).toEqual({ queries: ["Aurora", "orbit"] });
    expect(input).toEqual({ query: " Aurora ", queries: ["orbit", "aurora"] });
  });

  it("accepts queries as a string and preserves single-query pagination", () => {
    expect(HistorySearchInputSchema.parse({ queries: " Aurora " })).toEqual({
      queries: ["Aurora"],
    });
    expect(HistorySearchInputSchema.parse({ query: " Aurora ", beforeSeq: 0 })).toEqual({
      query: "Aurora",
      beforeSeq: 0,
    });
    expect(HistorySearchInputSchema.parse({ query: "Aurora", queries: "orbit" })).toEqual({
      queries: ["Aurora", "orbit"],
    });
  });

  it.each([null, "", " \n "])("omits empty optional search fields: %j", (blank) => {
    const optional = [
      "scope",
      "botId",
      "kinds",
      "queries",
      "offset",
      "before",
      "after",
      "beforeSeq",
      "limit",
    ];
    expect(
      HistorySearchInputSchema.parse({
        ...Object.fromEntries(optional.map((key) => [key, blank])),
        query: "Aurora",
      }),
    ).toEqual({ query: "Aurora" });
    expect(HistorySearchInputSchema.parse({ query: blank, queries: ["orbit"] })).toEqual({
      queries: ["orbit"],
    });
    expect(HistorySearchInputSchema.safeParse({ query: blank, queries: blank }).success).toBe(
      false,
    );
  });

  it("rejects invalid values and excess combined queries instead of dropping them", () => {
    for (const input of [
      { query: "a", queries: 42 },
      { query: false, queries: ["b"] },
      { query: "a", queries: ["b", "c", "d", "e", "f"] },
      { query: "a", limit: 0 },
      { query: "a", beforeSeq: "0" },
      { query: "a", scope: false },
    ])
      expect(HistorySearchInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("history read arguments", () => {
  it.each([null, "", " \n "])("omits empty optional read fields: %j", (blank) => {
    const optional = [
      "threadId",
      "linkedRunId",
      "runAfterId",
      "artifactAfterId",
      "outcomeAfterSeq",
      "textOffset",
      "attachmentOffset",
      "direction",
      "limit",
    ];
    expect(
      HistoryReadInputSchema.parse({
        messageId: "message-1",
        ...Object.fromEntries(optional.map((key) => [key, blank])),
      }),
    ).toEqual({ messageId: "message-1" });
    expect(HistoryReadInputSchema.safeParse({ messageId: blank }).success).toBe(false);
  });

  it("preserves zero cursors and rejects malformed required IDs and optional values", () => {
    const input = {
      messageId: "message-1",
      textOffset: 0,
      attachmentOffset: 0,
      outcomeAfterSeq: 0,
    };
    expect(HistoryReadInputSchema.parse(input)).toEqual(input);
    for (const args of [
      {},
      { messageId: " " },
      { ...input, direction: "all" },
      { ...input, limit: false },
    ]) {
      expect(HistoryReadInputSchema.safeParse(args).success).toBe(false);
    }
  });
});

describe("history query byte budget", () => {
  it("accepts 3000 serialized UTF-8 bytes and rejects one byte more", () => {
    const queries = ["星".repeat(499), `${"界".repeat(498)}xx`];
    expect(new TextEncoder().encode(JSON.stringify(queries)).length).toBe(3000);
    expect(HistorySearchInputSchema.safeParse({ queries }).success).toBe(true);
    expect(
      HistorySearchInputSchema.safeParse({ queries: [`${queries[0]}x`, queries[1]] }).success,
    ).toBe(false);
    expect(
      HistorySearchInputSchema.safeParse({
        queries: Array.from({ length: 5 }, (_, i) => "星".repeat(499) + i),
      }).success,
    ).toBe(false);
    expect(HistorySearchInputSchema.safeParse({ query: "x", queries }).success).toBe(false);
  });
});
