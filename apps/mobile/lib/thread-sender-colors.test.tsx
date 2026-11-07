// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 tests are preserved; mobile decision-card checks are Ork additions.

import { resolvePersonaColorDef, shouldShowBotSenderName } from "@orkbot/core";
import { botColors, darkTokens } from "@orkbot/ui-tokens";
import type { ComponentProps } from "react";
import { createContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { MobileBot, MobileSnapshot } from "./api";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Appearance: { getColorScheme: () => "dark", addChangeListener: () => ({ remove() {} }) },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios", select: (options: { ios?: unknown }) => options.ios },
  Pressable: "button",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "span",
  TextInput: "input",
  View: "div",
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  useAnimatedStyle: (style: () => unknown) => style(),
  useReducedMotion: () => true,
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

vi.mock("expo-secure-store", () => ({}));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
vi.mock("./network-cache", () => ({ clearNetworkCache: vi.fn() }));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./native", () => ({ native: {}, useResolvedAppearance: () => "dark" }));

vi.mock("@orkbot/chat-ui/native", () => ({
  MarkdownLongPressContext: createContext(undefined),
  ChatMarkdown: () => null,
  withBlockMentions: <T,>(blocks: T) => blocks,
}));

vi.mock("../components/message-caption", () => ({
  MessageCaption: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("../components/pages/page-card", () => ({ PageCard: () => null }));
vi.mock("../components/ComputerCard", () => ({
  ComputerCard: ({ onOpen }: { onOpen: () => void }) => {
    onOpen();
    return null;
  },
}));
// Cards this file doesn't exercise; each has its own tests.
vi.mock("../components/thread/ask-block", () => ({ AskBlock: () => null }));
vi.mock("../components/AskActions", () => ({
  AskActions: ({ actions }: { actions: Array<{ id: string; label: string }> }) => (
    <>
      {actions.map((action) => (
        <button type="button" key={action.id}>
          {action.label}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/audio-attachment", () => ({ AudioAttachment: () => null }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => null }));
vi.mock("../components/ChoiceCard", () => ({ ChoiceCard: () => null }));
vi.mock("../components/inline-image-attachment", () => ({ InlineImageAttachment: () => null }));
vi.mock("../components/change-undo", () => ({
  ChangeUndo: () => null,
  isUndoableChange: () => false,
}));
vi.mock("../components/McpApprovalCard", () => ({ McpApprovalCard: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));

import { MessageBubble } from "../components/thread/message-bubble";

type BubbleProps = ComponentProps<typeof MessageBubble>;

function Bubble(props: Partial<BubbleProps> & Pick<BubbleProps, "message">) {
  return (
    <MessageBubble
      botId="bot-1"
      bots={[]}
      showBotSenderName={false}
      canAnswer={false}
      canDismiss={false}
      onAnswer={async () => undefined}
      onOpenBot={() => undefined}
      onOpenComputer={() => undefined}
      onPreviewFile={() => undefined}
      onPreviewImage={() => undefined}
      onOpenPeerChat={() => undefined}
      actionProps={{}}
      {...props}
    />
  );
}

function contrastRatio(text: string, surface: string): number {
  const luminance = (hex: string) =>
    [1, 3, 5].reduce((sum, offset, i) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return (
        sum +
        [0.2126, 0.7152, 0.0722][i]! * (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      );
    }, 0);
  return (luminance(text) + 0.05) / (luminance(surface) + 0.05);
}

it.each(["text", "image"] as const)("keeps per-bot sender colours on %s messages", (kind) => {
  for (const [index, color] of botColors.entries()) {
    const id = `bot-${index}`;
    const html = renderToStaticMarkup(
      <Bubble
        botId={id}
        groupId="group"
        showBotSenderName={true}
        bots={[{ id, color } as MobileBot]}
        members={[{ botId: id, name: "Sender" }] as MobileSnapshot["members"]}
        message={{
          id: "message",
          role: "bot",
          botId: id,
          blocks: [
            kind === "text"
              ? { kind, text: "Hello" }
              : { kind, name: "Picture", artifactId: "artifact-1", mimeType: "image/png" },
          ],
        }}
        actionProps={{}}
      />,
    );
    const senderColor = resolvePersonaColorDef(id, color).hex;
    expect(html).toContain(`color:${senderColor}`);
    for (const surface of [darkTokens.muted, darkTokens.background]) {
      expect(contrastRatio(senderColor, surface)).toBeGreaterThanOrEqual(3);
    }
    expect(html).toContain(">Sender</span>");
  }
});

it.each(["text", "image"] as const)(
  "shows %s sender labels only when speakers need distinguishing",
  (kind) => {
    for (const { isGroup, speakerBotIds, expected } of [
      { isGroup: false, speakerBotIds: ["bot-a", "bot-a"], expected: false },
      { isGroup: true, speakerBotIds: ["bot-a"], expected: true },
      { isGroup: false, speakerBotIds: ["bot-a", "bot-b"], expected: true },
    ]) {
      const html = renderToStaticMarkup(
        <Bubble
          botId="bot-a"
          botName="Sender"
          bots={[]}
          groupId={isGroup ? "group" : undefined}
          showBotSenderName={shouldShowBotSenderName({ isGroup, speakerBotIds })}
          members={[{ botId: "bot-a", name: "Sender" }] as MobileSnapshot["members"]}
          message={{
            id: "message",
            role: "bot",
            botId: "bot-a",
            blocks: [
              kind === "text"
                ? { kind, text: "Hello" }
                : { kind, name: "Picture", artifactId: "artifact-1", mimeType: "image/png" },
            ],
          }}
          actionProps={{}}
        />,
      );
      expect(html.includes(">Sender</span>")).toBe(expected);
      if (!expected) expect(html).not.toContain("margin-bottom:4px");
    }
  },
);

it("keeps the bot name when opening a computer without a sender label", () => {
  const opened: string[][] = [];
  renderToStaticMarkup(
    <Bubble
      botId="bot-a"
      botName="Sender"
      bots={[]}
      showBotSenderName={false}
      message={{
        id: "message",
        role: "bot",
        botId: "bot-a",
        blocks: [{ kind: "computer", state: "ready", text: "" }],
      }}
      onOpenComputer={(...args) => opened.push(args)}
      actionProps={{}}
    />,
  );
  expect(opened).toEqual([["bot-a", "Sender"]]);
});

it.each([undefined, false, true])(
  "keeps pending mobile legacy approvals once-only with eligibility %s",
  (allowRule) => {
    const ask = {
      kind: "ask" as const,
      text: "Review?",
      detail: "Draft proposal",
      status: "pending" as const,
      approvalEffectId: "effect-1",
      ...(allowRule === undefined ? {} : { allowRule }),
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    };
    const message = { id: "decision", role: "bot" as const, blocks: [ask] };
    const pending = renderToStaticMarkup(<Bubble message={message} canAnswer />);
    expect(pending.includes("Always allow this tool")).toBe(allowRule === true);
    expect(pending).toContain("Allow once");
    expect(pending).toContain("Deny");
    expect(pending).toContain("Draft proposal");
    const answered = renderToStaticMarkup(
      <Bubble
        message={{
          ...message,
          blocks: [
            { ...ask, status: "answered", answer: "always", approvalReason: "scheduled_command" },
          ],
        }}
      />,
    );
    expect(answered).toContain("Always allowed");
    expect(answered).toContain("Scheduling a command requires approval.");
    expect(answered).toContain("Draft proposal");
  },
);
