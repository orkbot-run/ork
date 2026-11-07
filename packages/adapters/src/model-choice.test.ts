// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 selection tests are preserved; synthetic version fixtures follow LICENSE.md.

import type { PrismaClient } from "@orkbot/db";
import { describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "./model-choice.js";
import { matchModelChoice, resolveModelChoice } from "./model-choice.js";

const choice = (provider: string, providerName: string, id: string, label: string) => ({
  provider,
  providerName,
  id,
  label,
});

const choices: ModelChoice[] = [
  choice("anthropic", "Anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  choice("anthropic", "Anthropic", "claude-sonnet-5-5", "Claude Sonnet 5.5"),
  choice("openrouter", "OpenRouter", "anthropic/claude-sonnet-5.5", "Anthropic: Claude Sonnet 5.5"),
  choice("google", "Google", "gemini-3.7-flash", "Gemini 3.7 Flash"),
  choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
  choice("google", "Google", "gemini-3.8-flash-lite", "Gemini 3.8 Flash Lite"),
];

const matched = (query: string, preferred?: string) => {
  const { match } = matchModelChoice(choices, query, preferred);
  return match && `${match.provider}/${match.id}`;
};

describe("matchModelChoice", () => {
  it("matches exact ids, with or without the provider", () => {
    expect(matched("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("OpenRouter/anthropic/claude-sonnet-5.5")).toBe(
      "openrouter/anthropic/claude-sonnet-5.5",
    );
  });

  it("reads a loose name as the newest plain model of that family", () => {
    expect(matched("Claude Sonnet")).toBe("anthropic/claude-sonnet-5-5");
    expect(matched("gemini flash")).toBe("google/gemini-3.8-flash");
    expect(matched("Gemini Flash Lite")).toBe("google/gemini-3.8-flash-lite");
  });

  it("keeps a spoken version exact", () => {
    expect(matched("sonnet 5")).toBe("anthropic/claude-sonnet-5");
    expect(matched("Gemini 3.7 Flash")).toBe("google/gemini-3.7-flash");
  });

  it("prefers the bot's current provider", () => {
    expect(matched("Claude Sonnet", "openrouter")).toBe("openrouter/anthropic/claude-sonnet-5.5");
  });

  it("returns ranked candidates instead of guessing between equal matches", () => {
    const twins = [
      choice("google", "Google", "gemini-3.8-flash", "Gemini 3.8 Flash"),
      choice("google-vertex", "Vertex", "gemini-3.8-flash", "Gemini 3.8 Flash"),
    ];
    const { match, ranked } = matchModelChoice(twins, "Gemini 3.8 Flash");
    expect(match).toBeUndefined();
    expect(ranked).toHaveLength(2);
  });

  it("matches nothing for an unknown name", () => {
    expect(matchModelChoice(choices, "llama").ranked).toEqual([]);
  });
});

describe("synthetic model versions", () => {
  const synthetic = (id: string, label = id, provider = "example") =>
    choice(provider, provider, id, label);

  it("recognizes hyphenated label versions in dotted and spoken queries", () => {
    const older = synthetic("fiction-3-1", "Fiction 3-1");
    const newer = synthetic("fiction-3-2", "Fiction 3-2");
    for (const query of ["Fiction", "Fiction 3.2", "Fiction 3-2"])
      expect(matchModelChoice([older, newer], query).match).toEqual(newer);
    expect(matchModelChoice([older, newer], "Fiction 3.1").match).toEqual(older);
  });

  it("compares every component of a hyphenated patch version", () => {
    const older = synthetic("fiction-1-5-0", "Fiction 1-5-0");
    const newer = synthetic("fiction-1-5-1", "Fiction 1-5-1");
    expect(matchModelChoice([older, newer], "Fiction").match).toEqual(newer);
    expect(matchModelChoice([older, newer], "Fiction 1.5.0").match).toEqual(older);
  });

  it.each([
    ["70B", "8B"],
    ["135M", "1.5M"],
    ["4x8B", "3x70B"],
    ["2025-10-08", "2026-11-07"],
    ["20251008", "20261107"],
  ])("does not rank unversioned sizes or dated builds as a newer version: %s / %s", (a, b) => {
    const candidates = [
      synthetic(`fiction-${a}`, `Fiction ${a}`),
      synthetic(`fiction-${b}`, `Fiction ${b}`),
    ];
    const result = matchModelChoice(candidates, "Fiction");
    expect(result.ranked).toHaveLength(2);
    expect(result.match).toBeUndefined();
  });

  it.each([
    ["70B", "8B"],
    ["135M", "1.5M"],
    ["4x8B", "3x70B"],
    ["2025-10-08", "2026-11-07"],
    ["20251008", "20261107"],
  ])("keeps version 3-2 separate from size/date suffixes: %s / %s", (a, b) => {
    const candidates = [
      synthetic(`fiction-3-2-${a}`, `Fiction 3-2-${a}`),
      synthetic(`fiction-3-2-${b}`, `Fiction 3-2-${b}`),
    ];
    const result = matchModelChoice(candidates, "Fiction 3.2");
    expect(result.ranked).toHaveLength(2);
    expect(result.match).toBeUndefined();
    expect(matchModelChoice(candidates, `example/${candidates[0]!.id}`).match).toEqual(
      candidates[0],
    );
  });

  it("keeps an explicit size and the preferred provider as meaningful disambiguation", () => {
    const small = synthetic("fiction-3-2-8b", "Fiction 3-2-8B");
    const large = synthetic("fiction-3-2-70b", "Fiction 3-2-70B");
    expect(matchModelChoice([small, large], "Fiction 3.2 70B").match).toEqual(large);
    const other = synthetic("fiction-3.2-70b", "Fiction 3.2 70B", "other");
    expect(matchModelChoice([large, other], "Fiction 3.2 70B").match).toBeUndefined();
    expect(matchModelChoice([large, other], "Fiction 3.2 70B", "other").match).toEqual(other);
  });

  it("recognizes a dated build independently when a version and size also exist", () => {
    const first = synthetic("fiction-3-2-2025-10-08-70b", "Fiction 3-2-2025-10-08-70B");
    const second = synthetic("fiction-3-2-20261107-8b", "Fiction 3-2-20261107-8B");
    expect(matchModelChoice([first, second], "Fiction 3.2").match).toBeUndefined();
    expect(matchModelChoice([first, second], "Fiction 3.2 20251008").match).toEqual(first);
  });

  it("retains family M and v prefixes when they introduce a version", () => {
    for (const prefix of ["M", "v"]) {
      const older = synthetic(`fiction-${prefix}3-1`, `Fiction ${prefix}3-1`);
      const newer = synthetic(`fiction-${prefix}3-2`, `Fiction ${prefix}3-2`);
      expect(matchModelChoice([older, newer], `Fiction ${prefix}`).match).toEqual(newer);
      expect(matchModelChoice([older, newer], `Fiction ${prefix}3.1`).match).toEqual(older);
    }
  });
});

function connected(providers: string[]) {
  const credentials = providers.map((provider) => ({
    id: `cred-${provider}`,
    provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => credentials) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findMany: vi.fn(async () =>
        credentials.map((credential) => ({ id: credential.secretId, ciphertext: "fake" })),
      ),
    },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    secretStore: { load: async () => "fake-api-key" },
  };
}

const scope = { userId: "user-1", spaceId: "space-1" };

describe("resolveModelChoice", () => {
  it("resolves a loose name against the connected providers' models", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "gemini flash" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-3.8-flash" });
  });

  it("names the provider to connect when only another provider has the model", async () => {
    const result = await resolveModelChoice(connected(["google"]), scope, {
      model: "Claude Sonnet",
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/connect .*Anthropic.* in Settings first/),
    });
  });

  it("passes an exact provider/id through for the model check to judge", async () => {
    expect(
      await resolveModelChoice(connected(["google"]), scope, { model: "google/gemini-live-x" }),
    ).toEqual({ ok: true, provider: "google", model: "gemini-live-x" });
  });

  it("says when no model anywhere matches", async () => {
    expect(await resolveModelChoice(connected([]), scope, { model: "zzz-unknown" })).toEqual({
      ok: false,
      error: 'No model matches "zzz-unknown".',
    });
  });

  it("bounds the echoed query in errors", async () => {
    const elsewhere = await resolveModelChoice(connected(["google"]), scope, {
      model: `${"claude ".repeat(10_000)}sonnet`,
    });
    expect(elsewhere).toMatchObject({ ok: false });
    if (!elsewhere.ok) {
      expect(elsewhere.error).toContain("No connected model matches");
      expect(elsewhere.error.length).toBeLessThan(600);
    }
    const nowhere = await resolveModelChoice(connected([]), scope, {
      model: "z".repeat(60_000),
    });
    expect(nowhere).toMatchObject({ ok: false });
    if (!nowhere.ok) expect(nowhere.error.length).toBeLessThan(400);
  });
});
