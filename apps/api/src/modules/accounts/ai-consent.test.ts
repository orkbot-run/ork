// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache tests are retained; send consent coverage follows LICENSE.md.

import { aiRecipient } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import { AI_DISCLOSURE_VERSION, OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("#modules/threads/thread-target", () => ({
  resolveThreadTarget: async () => ({ kind: "bot", botId: "bot" }),
}));

import type { Prisma } from "@orkbot/db";
import type { RouterDeps } from "#modules/platform/router";
import { aiConsentStatus, allowAiConsent, prepareSendAiConsent } from "./ai-consent.js";

function setup() {
  const upsert = vi.fn(async () => ({}));
  const deps = {
    env: { agentRuntime: "scripted" },
    prisma: {
      userModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      secret: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      bot: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      userVoicePreference: {
        findFirst: vi.fn(async () => ({ credential: { provider: "openai" }, voiceId: "alloy" })),
        findMany: vi.fn(async () => [{ credential: { provider: "openai" } }]),
      },
      spaceMemoryConfig: { findUnique: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      aiDataConsent: { findMany: vi.fn(async () => []), upsert },
      $transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) =>
        write({ aiDataConsent: { upsert } }),
      ),
    },
  } as unknown as RouterDeps;
  return { deps, upsert, actor: { userId: "user", spaceId: "space" } as Actor };
}
describe("consent grants", () => {
  it("includes reachable helper models and cloud services for a targeted send", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    vi.mocked(deps.prisma.userModelPreference.findMany).mockResolvedValue([
      {
        modelId: "helper-model",
        credential: { provider: "anthropic", secretId: "test-secret" },
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients.map((recipient) => recipient.name)).toEqual(
      expect.arrayContaining(["Anthropic", "Cursor"]),
    );
    expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot"] } }) }),
    );
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: { in: ["bot"] },
          active: true,
        }),
      }),
    );
  });
  it("authorizes explicit paused routines outside the active chat's bot filter", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.routine.findMany).mockResolvedValueOnce([
      {
        id: "routine-1",
        botId: "other-bot",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
      },
    ] as never);
    await aiConsentStatus(deps, actor, {
      botId: "bot",
      routineIds: ["routine-1", "routine-1"],
      uses: ["model"],
    });
    expect(deps.prisma.routine.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: { in: ["routine-1"] },
          userId: actor.userId,
          spaceId: actor.spaceId,
          bot: { userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
        },
      }),
    );
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["bot", "other-bot"] } }),
      }),
    );
    expect(deps.prisma.routine.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ botId: { in: ["bot"] }, active: true }),
      }),
    );
  });
  it("rejects unavailable explicit targets before returning a disclosure", async () => {
    const { deps, actor } = setup();
    await expect(
      aiConsentStatus(deps, actor, { routineIds: ["foreign-routine"], uses: [] }),
    ).rejects.toThrow();
  });
  it("reuses only the request's prepared endpoint secrets and fails closed on changed ciphertext", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    const load = vi.fn(async () =>
      JSON.stringify({ kind: "openai_compatible", baseUrl: "https://model.example.test/v1" }),
    );
    deps.secrets = { load } as unknown as RouterDeps["secrets"];
    vi.mocked(deps.prisma.userModelPreference.findMany).mockResolvedValue([
      { modelId: "fixture-model", credential: { provider: "fixture", secretId: "secret" } },
    ] as never);
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue([
      { id: "secret", ciphertext: "prepared" },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    vi.mocked(deps.prisma.aiDataConsent.findMany).mockResolvedValue(
      status.recipients.map((recipient) => ({ recipientKey: recipient.key })) as never,
    );
    load.mockClear();
    const check = await prepareSendAiConsent(deps, actor, { botId: "bot" });
    const tx = {
      ...deps.prisma,
      $queryRaw: vi.fn(async () =>
        status.recipients.map((recipient) => ({ recipientKey: recipient.key })),
      ),
    } as unknown as Prisma.TransactionClient;
    await check(tx);
    expect(load).toHaveBeenCalledOnce();
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue([
      { id: "secret", ciphertext: "replaced" },
    ] as never);
    await expect(check(tx)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(load).toHaveBeenCalledOnce();
  });
  function endpointFixture() {
    const fixture = setup();
    const { deps, actor } = fixture;
    deps.env.agentRuntime = "pi";
    const credential = (id: string, updatedAt: Date) => ({
      id,
      userId: actor.userId,
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      label: id,
      secretId: id,
      createdAt: updatedAt,
      updatedAt,
    });
    const a = credential("connection-a", new Date("2026-01-02T00:00:00Z"));
    const b = credential("connection-b", new Date("2026-01-01T00:00:00Z"));
    const preference = {
      userId: actor.userId,
      credentialId: a.id,
      credential: a,
      modelId: "model-y",
      thinkingLevel: null,
      updatedAt: a.updatedAt,
    };
    const rows = [
      {
        id: a.secretId,
        ciphertext: JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://preferred.example.test/v1",
          enabledModelIds: ["model-y"],
        }),
      },
      {
        id: b.secretId,
        ciphertext: JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://enabled.example.test/v1",
          enabledModelIds: ["model-x"],
        }),
      },
    ];
    deps.secrets = {
      load: vi.fn(async (value: string) => value),
    } as unknown as RouterDeps["secrets"];
    vi.mocked(deps.prisma.userModelPreference.findMany).mockResolvedValue([preference] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([a, b] as never);
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue(rows as never);
    vi.mocked(deps.prisma.secret.findFirst).mockImplementation(
      (args) => Promise.resolve(rows.find((row) => row.id === args?.where?.id)) as never,
    );
    return { ...fixture, a, b, preference };
  }
  it.each(["bot", "role"] as const)(
    "discloses the allowlist-aware %s connection rather than a different preferred endpoint",
    async (kind) => {
      const { deps, actor } = endpointFixture();
      if (kind === "bot")
        vi.mocked(deps.prisma.bot.findMany).mockResolvedValue([
          { modelProvider: OPENAI_COMPATIBLE_PROVIDER_ID, modelId: "model-x", thinkingLevel: null },
        ] as never);
      else
        vi.mocked(deps.prisma.userModelRoleChoice.findMany).mockResolvedValue([
          {
            role: "computer",
            position: 0,
            provider: OPENAI_COMPATIBLE_PROVIDER_ID,
            modelId: "model-x",
            credentialId: null,
          },
        ] as never);
      const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
      const expected = [
        "https://enabled.example.test/v1",
        ...(kind === "bot" ? ["https://preferred.example.test/v1"] : []),
      ].map(
        (baseUrl) =>
          aiRecipient({
            provider: OPENAI_COMPATIBLE_PROVIDER_ID,
            modelId: "model-x",
            baseUrl,
            use: "model",
          })!.key,
      );
      expect(
        new Set(
          status.recipients
            .filter((recipient) => recipient.detail === "model-x")
            .map((recipient) => recipient.key),
        ),
      ).toEqual(new Set(expected));
    },
  );
  it("requires an explicit role connection to belong to the role's provider, without a fallback", async () => {
    const { deps, actor, b } = endpointFixture();
    vi.mocked(deps.prisma.userModelRoleChoice.findMany).mockResolvedValue([
      {
        role: "computer",
        position: 0,
        provider: "different-fixture-provider",
        modelId: "model-x",
        credentialId: b.id,
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(deps.prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: b.id, userId: actor.userId, provider: "different-fixture-provider" },
      }),
    );
    expect(status.recipients.some((recipient) => recipient.detail === "model-x")).toBe(false);
  });
  it("matches the explicit team judge's provider-only credential choice instead of a model-owning preference", async () => {
    const { deps, actor, b, preference } = endpointFixture();
    deps.env.teamChatJudgeProvider = OPENAI_COMPATIBLE_PROVIDER_ID;
    deps.env.teamChatJudgeModel = "model-x";
    vi.mocked(deps.prisma.userModelPreference.findMany).mockResolvedValue([
      preference,
      {
        ...preference,
        credentialId: b.id,
        credential: b,
        modelId: "model-x",
        updatedAt: b.updatedAt,
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    const expected = ["https://preferred.example.test/v1", "https://enabled.example.test/v1"].map(
      (baseUrl) =>
        aiRecipient({
          provider: OPENAI_COMPATIBLE_PROVIDER_ID,
          modelId: "model-x",
          baseUrl,
          use: "model",
        })!.key,
    );
    expect(
      new Set(
        status.recipients
          .filter((recipient) => recipient.detail === "model-x")
          .map((recipient) => recipient.key),
      ),
    ).toEqual(new Set(expected));
  });
  it("includes every purpose's selected models in the provider-sharing disclosure until each is allowed", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.userModelRoleChoice.findMany).mockResolvedValue([
      {
        role: "main",
        position: 1,
        provider: "anthropic",
        modelId: "claude-backup",
        thinkingLevel: null,
      },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "backup-credential",
        userId: actor.userId,
        provider: "anthropic",
        label: "fixture",
        secretId: "backup-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as never);

    const status = await aiConsentStatus(deps, actor, { uses: ["model"] });

    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Anthropic",
          detail: "claude-backup",
          use: "model",
          allowed: false,
        }),
      ]),
    );
    expect(deps.prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: actor.userId },
        orderBy: [{ role: "asc" }, { position: "asc" }],
      }),
    );
    expect(deps.prisma.spaceModelRoleChoice.findMany).not.toHaveBeenCalled();
  });
  it("discloses a Space's own models instead of the account's when it overrides them", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
      setting: "models",
    } as never);
    await aiConsentStatus(deps, actor, { uses: ["model"] });
    expect(deps.prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: actor.userId, spaceId: actor.spaceId } }),
    );
    expect(deps.prisma.userModelRoleChoice.findMany).not.toHaveBeenCalled();
  });
  it("discloses only the selected voice provider before a voice action", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.userVoicePreference.findMany).mockResolvedValue([
      { credential: { provider: "openai" } },
      { credential: { provider: "elevenlabs" } },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]?.name).toBe("OpenAI");
    expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
  });
  it("returns an operator policy without requiring a hosted provider", async () => {
    const { deps, actor } = setup();
    deps.env.privacyPolicyUrl = "https://example.com/privacy";
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe("https://example.com/privacy");
  });
  it("rejects stale disclosures, unknown recipients, and a changed account or Space", async () => {
    const { deps, actor, upsert } = setup();
    const current = await aiConsentStatus(deps, actor);
    const input = {
      scope: current.scope,
      version: current.version,
      keys: [current.recipients[0]!.key],
    };
    for (const invalid of [
      { ...input, version: "old" },
      { ...input, scope: "different-account" },
      { ...input, keys: ["unknown"] },
    ]) {
      await expect(allowAiConsent(deps, actor, invalid)).rejects.toThrow("changed");
    }
    expect(upsert).not.toHaveBeenCalled();
    await allowAiConsent(deps, actor, input);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: AI_DISCLOSURE_VERSION,
        },
      }),
    );
  });
});

it("discloses the self-hosted voice origin without its encrypted key", async () => {
  const { deps, actor } = setup();
  vi.mocked(deps.prisma.userVoicePreference.findFirst).mockResolvedValue({
    credential: { provider: "openai-compatible", secretId: "voice-secret" },
    voiceId: "af_heart",
  } as never);
  deps.prisma.secret.findFirst = vi
    .fn()
    .mockResolvedValue({ id: "voice-secret", ciphertext: "encrypted-fixture" });
  deps.secrets = {
    load: vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://100.64.0.10:8810/v1",
        apiKey: "local-test-key",
        ttsModel: "kokoro",
        sttModel: "whisper-1",
      }),
    ),
    put: vi.fn(),
  } as never;
  const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
  expect(status.recipients).toHaveLength(1);
  expect(JSON.stringify(status)).toContain("http://100.64.0.10:8810");
  expect(JSON.stringify(status)).not.toContain("local-test-key");
  expect(JSON.stringify(status)).not.toContain("apiKey");
});

it("discloses the Space's own voices where it overrides voice", async () => {
  const { deps, actor } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findMany: vi.fn(async () => [{ credential: { provider: "elevenlabs" } }]),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const status = await aiConsentStatus(deps, actor);
  expect(status.recipients.map((recipient) => recipient.name)).toEqual(["ElevenLabs"]);
  expect(deps.prisma.userVoicePreference.findMany).not.toHaveBeenCalled();
});

it("asks about the account's voice provider when a voice action names the account copy", async () => {
  const { deps, actor } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findFirst: vi.fn(async () => ({ credential: { provider: "elevenlabs" }, voiceId: "space" })),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const applied = await aiConsentStatus(deps, actor, { uses: ["voice"] });
  expect(applied.recipients.map((recipient) => recipient.name)).toEqual(["ElevenLabs"]);
  const account = await aiConsentStatus(deps, actor, {
    uses: ["voice"],
    settingsScope: "account",
  });
  expect(account.recipients.map((recipient) => recipient.name)).toEqual(["OpenAI"]);
});

it("grants the account's voice provider when the grant names the account copy", async () => {
  const { deps, actor, upsert } = setup();
  Object.assign(deps.prisma, {
    spaceVoicePreference: {
      findMany: vi.fn(async () => [{ credential: { provider: "elevenlabs" } }]),
    },
  });
  vi.mocked(deps.prisma.spaceSettingOverride.findUnique).mockResolvedValue({
    setting: "voice",
  } as never);
  const reviewed = await aiConsentStatus(deps, actor, {
    uses: ["voice"],
    settingsScope: "account",
  });
  const keys = reviewed.recipients.map((recipient) => recipient.key);
  await expect(
    allowAiConsent(deps, actor, { scope: reviewed.scope, version: reviewed.version, keys }),
  ).rejects.toThrow("AI data sharing changed");
  await allowAiConsent(deps, actor, {
    scope: reviewed.scope,
    version: reviewed.version,
    keys,
    settingsScope: "account",
  });
  expect(upsert).toHaveBeenCalled();
});
