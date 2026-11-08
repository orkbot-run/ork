// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it } from "vitest";
import {
  MessagingLinkedIdentitySchema,
  MessagingOutboundListSchema,
  MessagingOutboundResolutionSchema,
} from "./domain.js";

const item = {
  id: "outbound-1",
  version: "a".repeat(64),
  preview: "Plain committed text",
  createdAt: "2026-01-01T00:00:00Z",
  attachmentName: null,
};
it("preserves previous-release linked identity DTOs and optional scoped review", () => {
  const identity = {
    id: "identity-1",
    botId: "bot-1",
    provider: "fixture",
    address: "fixture",
    botName: "Bot",
  };
  expect(MessagingLinkedIdentitySchema.parse(identity)).toEqual(identity);
  expect(
    MessagingLinkedIdentitySchema.parse({
      ...identity,
      deliveryReview: { spaceId: "space-1", count: 1 },
    }).deliveryReview,
  ).toEqual({ spaceId: "space-1", count: 1 });
  expect(
    MessagingLinkedIdentitySchema.safeParse({
      ...identity,
      deliveryReview: { spaceId: "space-1", count: -1 },
    }).success,
  ).toBe(false);
});
it("bounds plain review data and accepts only terminal manual decisions", () => {
  expect(MessagingOutboundListSchema.parse({ items: [item], hasMore: false }).items).toEqual([
    item,
  ]);
  for (const patch of [
    { version: "unknown" },
    { preview: "x".repeat(1001) },
    { attachmentName: "x".repeat(201) },
  ])
    expect(
      MessagingOutboundListSchema.safeParse({ items: [{ ...item, ...patch }], hasMore: false })
        .success,
    ).toBe(false);
  expect(
    MessagingOutboundListSchema.safeParse({
      items: Array.from({ length: 21 }, () => item),
      hasMore: true,
    }).success,
  ).toBe(false);
  expect(MessagingOutboundResolutionSchema.parse("confirmed_sent")).toBe("confirmed_sent");
  expect(MessagingOutboundResolutionSchema.parse("confirmed_not_sent")).toBe("confirmed_not_sent");
  expect(MessagingOutboundResolutionSchema.safeParse("retry").success).toBe(false);
});
