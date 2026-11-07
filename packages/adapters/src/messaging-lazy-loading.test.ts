// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type * as SlackSdk from "@chat-adapter/slack";
import { expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => ({
  slack: vi.fn(),
  telegram: vi.fn(),
  whatsapp: vi.fn(),
  sendblue: vi.fn(),
  failSlackConstruction: false,
}));
vi.mock("@chat-adapter/slack", async (original) => {
  loaded.slack();
  const sdk = await original<typeof SlackSdk>();
  return {
    ...sdk,
    createSlackAdapter: (...args: Parameters<typeof sdk.createSlackAdapter>) => {
      if (loaded.failSlackConstruction) {
        loaded.failSlackConstruction = false;
        throw new Error("fixture adapter construction failed");
      }
      return sdk.createSlackAdapter(...args);
    },
  };
});
vi.mock("@chat-adapter/telegram", async (original) => {
  loaded.telegram();
  return original();
});
vi.mock("@chat-adapter/whatsapp", async (original) => {
  loaded.whatsapp();
  return original();
});
vi.mock("chat-adapter-sendblue", async (original) => {
  loaded.sendblue();
  return original();
});

import { messagingPlatformsFromEnv, splitOutboundBody } from "./messaging-platforms.js";

it("loads only configured SDKs or a formatter actually used, retaining errors and construction retry", async () => {
  const counts = () =>
    [loaded.slack, loaded.telegram, loaded.whatsapp, loaded.sendblue].map(
      (load) => load.mock.calls.length,
    );
  expect(counts()).toEqual([0, 0, 0, 0]);
  for (const partial of [
    {},
    { slackBotToken: "fake" },
    { telegramBotToken: "fake" },
    { whatsappAccessToken: "fake" },
    { sendblueApiKeyId: "fake" },
  ])
    expect(await messagingPlatformsFromEnv(partial)).toEqual([]);
  expect(counts()).toEqual([0, 0, 0, 0]);
  const telegram = { telegramBotToken: "fake", telegramWebhookSecret: "fake-secret" };
  const first = await messagingPlatformsFromEnv(telegram);
  const second = await messagingPlatformsFromEnv(telegram);
  expect(first[0]!.adapter).not.toBe(second[0]!.adapter);
  expect(counts()).toEqual([0, 1, 0, 0]);
  expect(await splitOutboundBody("telegram", "short")).toEqual(["short"]);
  expect(counts()).toEqual([0, 1, 0, 0]);
  // Existing long-message formatting reuses the WhatsApp SDK's exported splitter.
  const long = "a".repeat(5000);
  expect((await splitOutboundBody("telegram", long)).join("")).toBe(long);
  expect(counts()).toEqual([0, 1, 1, 0]);

  const slack = { slackBotToken: "xoxb-fake", slackSigningSecret: "fake-secret" };
  await messagingPlatformsFromEnv(slack);
  loaded.failSlackConstruction = true;
  await expect(messagingPlatformsFromEnv(slack)).rejects.toThrow(
    "fixture adapter construction failed",
  );
  expect((await messagingPlatformsFromEnv(slack))[0]!.provider).toBe("slack");
  expect(counts()).toEqual([1, 1, 1, 0]);

  const [whatsapp] = await messagingPlatformsFromEnv({
    whatsappAccessToken: "fake",
    whatsappPhoneNumberId: "fake",
    whatsappAppSecret: "fake",
    whatsappVerifyToken: "fake",
  });
  const { WhatsAppApiError } = await import("@chat-adapter/whatsapp");
  const failure = new WhatsAppApiError(
    "fixture",
    400,
    JSON.stringify({ error: { code: 131047, message: "fixture", type: "OAuthException" } }),
  );
  expect(whatsapp!.isPermanentSendError!(failure)).toBe(true);
  expect(
    whatsapp!.isPermanentSendError!(Object.assign(new Error("fixture"), { errorCode: 131047 })),
  ).toBe(false);
  await messagingPlatformsFromEnv({
    sendblueApiKeyId: "fake",
    sendblueApiSecret: "fake",
    sendblueSigningSecret: "fake",
    sendbluePhoneNumber: "+15550001111",
  });
  expect(counts()).toEqual([1, 1, 1, 1]);
});
