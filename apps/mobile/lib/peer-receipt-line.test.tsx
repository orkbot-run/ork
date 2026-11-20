// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { PeerReceiptLine } from "../components/peer-receipt-line";

const native = vi.hoisted(() => ({
  buttons: [] as Array<{
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }>,
  avatars: [] as string[],
  views: [] as Array<unknown>,
  textLines: [] as Array<number | undefined>,
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    native.views.push(style);
    return <div>{children}</div>;
  },
  Text: ({ children, numberOfLines }: { children?: ReactNode; numberOfLines?: number }) => {
    native.textLines.push(numberOfLines);
    return <span>{children}</span>;
  },
  Pressable: (props: (typeof native.buttons)[number] & { children?: ReactNode }) => {
    native.buttons.push(props);
    return <button type="button">{props.children}</button>;
  },
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("./native", () => ({ useThemedStyles: (create: () => unknown) => create() }));
vi.mock("./i18n", () => ({
  useI18n: () => ({ locale: "en" }),
  peerExchangeLabel: (count: number, direction: string, name: string) =>
    count === 1
      ? direction === "sent"
        ? `Messaged ${name}`
        : `Message from ${name}`
      : `${count} messages with ${name}`,
}));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ identity }: { identity: string }) => {
    native.avatars.push(identity);
    return null;
  },
}));

const defaults: ComponentProps<typeof PeerReceiptLine> = {
  peerBotId: "bot-0",
  peerBotName: "Bot 0",
  color: "muted",
  count: 1,
  direction: "sent",
  actionProps: {},
};

beforeEach(() => {
  native.buttons.length = 0;
  native.avatars.length = 0;
  native.views.length = 0;
  native.textLines.length = 0;
});

it.each([
  ["sent", "Messaged"],
  ["received", "Message from"],
] as const)("keeps every agent visible and actionable in a large %s group", (direction, label) => {
  const onLongPress = vi.fn();
  const recipients = Array.from({ length: 28 }, (_, index) => ({
    peerBotId: `bot-${index}`,
    peerBotName: `Recipient ${index}`,
    color: "muted",
    onPress: vi.fn(),
  }));
  const html = renderToStaticMarkup(
    <PeerReceiptLine
      {...defaults}
      direction={direction}
      recipients={recipients}
      actionProps={{ onLongPress }}
    />,
  );
  expect(native.avatars).toEqual(recipients.map((recipient) => recipient.peerBotId));
  expect(native.buttons).toHaveLength(28);
  expect(native.views).toContainEqual(
    expect.arrayContaining([expect.objectContaining({ flexWrap: "wrap" })]),
  );
  expect(native.textLines.every((lines) => lines === undefined)).toBe(true);
  expect(html).toContain(`${label} `);
  for (const [index, button] of native.buttons.entries()) {
    expect(button.accessibilityLabel).toBe(`${label} Recipient ${index}`);
    expect(button.accessibilityRole).toBe("button");
    button.onPress?.();
    expect(recipients[index]!.onPress).toHaveBeenCalledOnce();
    expect(button.onLongPress).toBe(onLongPress);
  }
});

it("preserves the incoming single-peer label and action", () => {
  const onPress = vi.fn();
  renderToStaticMarkup(<PeerReceiptLine {...defaults} direction="received" onPress={onPress} />);
  expect(native.buttons).toHaveLength(1);
  expect(native.buttons[0]!.accessibilityLabel).toBe("Message from Bot 0");
  native.buttons[0]!.onPress?.();
  expect(onPress).toHaveBeenCalledOnce();
});
