// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; source-owned composer recovery is an Ork addition.

import type { MessageBlock } from "@orkbot/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
// @vitest-environment jsdom
import type { MobileSnapshot } from "./api";
import type { SendAttempt } from "./thread-feedback";

const owner = vi.hoisted(() => ({
  apiBase: "https://app.example",
  spaceId: null as string | null,
  generation: 1,
  selectionGeneration: 0,
}));
vi.mock("expo-file-system", () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: "cache" },
}));

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => owner.apiBase,
  loadSessionToken: async () => "token",
  rpc: vi.fn(),
  selectedSpaceId: () => owner.spaceId,
  spaceSelectionSeq: () => owner.selectionGeneration,
}));
vi.mock("./i18n", () => ({ t: (text: string) => text, useI18n: () => ({ t: (s: string) => s }) }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: async () => undefined }));
vi.mock("./focus-prompt", () => ({ cancelFocusPrompt: () => undefined }));
vi.mock("./unsent-sends", () => ({ prepareUnsentSends: async () => undefined }));
vi.mock("./session", () => ({
  currentSessionGeneration: () => owner.generation,
  registerSessionDiskCache: () => undefined,
}));
vi.mock("./page-runtime", () => ({ loadPageRuntime: async () => "" }));

const { useThreadSend } = await import("./thread-send");
const { deliverSend } = await import("./thread-feedback");
const { offerPageReply } = await import("./pages");

type Sender = ReturnType<typeof useThreadSend>;
const card = (id: string, pageId: string): { id: string; role: "bot"; blocks: MessageBlock[] } => ({
  id,
  role: "bot",
  blocks: [{ kind: "page", pageId, version: 1, title: `Page ${pageId}` }],
});
const said = (id: string, text: string) => ({
  id,
  role: "user" as const,
  blocks: [{ kind: "text" as const, text }],
});

/** The chat's sender with `messages` loaded, a composer holding what replies add to it. */
async function chat(
  messages: object[],
  delivery: () => Promise<boolean | undefined> = async () => undefined,
) {
  const releaseAttachments = vi.fn();
  const captureForSend = vi.fn(() => releaseAttachments);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const payloads: unknown[] = [];
  let sender!: Sender;
  let draft = "";
  const snapRef: { current: MobileSnapshot | null } = {
    current: {
      threadId: "thread",
      botId: "bot-1",
      cursor: 0,
      olderCursor: null,
      run: null,
      messages: messages as MobileSnapshot["messages"],
    },
  };
  const snapshotOrigin = {
    current: {
      apiBase: owner.apiBase,
      userId: "owner",
      spaceId: "space",
      namespace: "namespace",
      sessionGeneration: owner.generation,
      selectionId: owner.spaceId,
      selectionGeneration: owner.selectionGeneration,
    },
  };
  const terminalRunReceipts = { current: new Set<string>() };
  const commitSnap = vi.fn((next: MobileSnapshot | null) => {
    snapRef.current = next;
  });
  const refresh = vi.fn<() => Promise<MobileSnapshot | undefined>>(async () => undefined);
  const activeBotId = { current: "bot-1" as string | undefined };
  const feedback = {
    setError: () => undefined,
    sendAttempt: (payload: unknown) => {
      payloads.push(payload);
      return { payload, clientNonce: "n1", artifactIds: new Map(), state: "queued" };
    },
    send: delivery,
  };
  function Harness() {
    sender = useThreadSend({
      botId: "bot-1",
      readOnly: false,
      threadKey: "bot-1",
      history: {
        snapRef,
        snapshotOrigin,
        commitSnap,
        pinnedAroundRef: { current: null },
        jumpScrollTarget: { current: null },
      },
      scroll: { follow: () => undefined, behavior: { current: { onOwnSend: () => undefined } } },
      feedback,
      attachments: {
        pendingAttachments: [],
        captureForSend,
        setPendingAttachments: () => undefined,
        setAttachmentNotice: () => undefined,
        importingShare: { current: false },
      },
      mentionBotsRef: { current: [] },
      activeBotId,
      activeGroupId: { current: undefined },
      isCurrentTarget: (botId: string | undefined, groupId: string | undefined) =>
        botId === activeBotId.current && !groupId,
      terminalRunReceipts,
      refresh,
      showLatest: () => undefined,
      markCaughtUp: () => undefined,
      openBotChat: () => undefined,
    } as never);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  sender.composerRef.current = {
    snapshot: () => ({
      promptText: draft,
      mentions: [],
      skill: null,
      replyTargetId: sender.replyTarget?.id,
      replyQuote: sender.replyQuote,
      attachmentIds: [],
    }),
    addReply: (text: string) => {
      draft = draft ? `${draft} ${text}` : text;
    },
    reset: () => {
      draft = "";
    },
  } as never;
  /** What the server receives for the composer's message. */
  const sent = async (): Promise<Record<string, unknown> | undefined> => {
    payloads.length = 0;
    await act(async () => sender.send());
    const request = vi.fn(async () => ({ seq: 1 }));
    const payload = payloads.at(-1) as Parameters<typeof deliverSend>[0];
    const attempt = { clientNonce: "n1", artifactIds: new Map() };
    await deliverSend(payload, attempt as never, request as never);
    return payload
      ? ((request.mock.calls.at(-1) as unknown[] | undefined)?.[1] as never)
      : undefined;
  };
  return {
    sender: () => sender,
    snapRef,
    snapshotOrigin,
    terminalRunReceipts,
    commitSnap,
    refresh,
    activeBotId,
    captureForSend,
    releaseAttachments,
    payloads,
    root,
    sent,
    tapOnPage: (pageId: string, title: string, text: string) =>
      act(async () => {
        offerPageReply("bot-1", { text, page: { id: pageId, title } });
        sender.receivePageReply();
      }),
  };
}

it("sends a page's reply about that page: its card here, else a link, over an earlier pick", async () => {
  // Two pages in the chat; the older one's reply answers its own card, not the newest page.
  const twoPages = await chat([card("m1", "p-old"), card("m2", "p-new"), said("m3", "hi")]);
  await twoPages.tapOnPage("p-old", "Old plan", "Use option B");
  expect(await twoPages.sent()).toMatchObject({
    botId: "bot-1",
    text: "Use option B",
    replyToMessageId: "m1",
    fromPage: true,
    replyQuote: undefined,
  });

  // A message picked to reply to before the page opened gives way to the page.
  await act(async () => twoPages.sender().setReplyTarget(said("m3", "hi") as never));
  await twoPages.tapOnPage("p-new", "New plan", "Ship it");
  expect(await twoPages.sent()).toMatchObject({ replyToMessageId: "m2", fromPage: true });
  await act(async () => twoPages.root.unmount());

  // The page's card isn't loaded here: the message names the page instead.
  const noCard = await chat([said("m3", "hi")]);
  await act(async () => noCard.sender().setReplyTarget(said("m3", "hi") as never));
  await noCard.tapOnPage("p-old", "Q3 [draft]", "Use option B");
  const linked = await noCard.sent();
  expect(linked).toMatchObject({ text: "[Q3 \\[draft\\]](page:p-old)\nUse option B" });
  expect([linked?.replyToMessageId, linked?.fromPage]).toEqual([undefined, undefined]);

  // Once sent, the next message is the user's own again.
  await act(async () => noCard.sender().composerRef.current?.addReply("just text"));
  expect(await noCard.sent()).toMatchObject({ text: "just text", fromPage: undefined });
  await act(async () => noCard.root.unmount());
});

it("keeps a reply the user picks after the page's reply lands", async () => {
  const picked = await chat([card("m1", "p-old"), said("m3", "hi")]);
  await picked.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => picked.sender().setReplyTarget(said("m3", "hi") as never));
  expect(await picked.sent()).toMatchObject({
    replyToMessageId: "m3",
    text: "Use option B",
    fromPage: undefined,
  });
  await act(async () => picked.root.unmount());
});

it("forgets the page once the user clears its reply from the composer", async () => {
  const cleared = await chat([card("m1", "p-old"), said("m3", "hi")]);
  await cleared.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => {
    cleared.sender().composerRef.current?.reset();
    cleared.sender().composerEmptied();
    cleared.sender().composerRef.current?.addReply("something else");
  });
  const sent = await cleared.sent();
  expect(sent).toMatchObject({ text: "something else" });
  expect([sent?.replyToMessageId, sent?.fromPage]).toEqual([undefined, undefined]);

  // Typed after the page's reply, not instead of it, the message still answers the page.
  await cleared.tapOnPage("p-old", "Old plan", "Use option B");
  await act(async () => cleared.sender().composerRef.current?.addReply("now"));
  expect(await cleared.sent()).toMatchObject({ replyToMessageId: "m1", fromPage: true });
  await act(async () => cleared.root.unmount());
});

it.each([true, false])(
  "releases the source attachment hold only for verified durable outbox admission: %s",
  async (durable) => {
    const feedbackModule = await import("./thread-feedback");
    const knownDurable = vi.spyOn(feedbackModule, "isUnsentSendDurable").mockReturnValue(durable);
    const fixture = await chat([]);
    try {
      await fixture.tapOnPage("page-1", "Plan", "keep this draft");
      await act(async () => fixture.sender().send());
      expect(fixture.captureForSend).toHaveBeenCalledOnce();
      expect(fixture.releaseAttachments).toHaveBeenCalledTimes(durable ? 1 : 0);
    } finally {
      await act(async () => fixture.root.unmount());
      knownDurable.mockRestore();
    }
  },
);

it("keeps newer mobile text separate when an earlier send remains in its outbox", async () => {
  let finish!: (accepted: boolean) => void;
  const fixture = await chat(
    [],
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await fixture.tapOnPage("source-page", "Plan", "original words");
    let sending!: Promise<void>;
    await act(async () => {
      sending = fixture.sender().send();
    });
    await fixture.tapOnPage("new-page", "Next", "newer words");
    await act(async () => {
      finish(false);
      await sending;
    });
    expect(fixture.sender().composerRef.current?.snapshot().promptText).toBe("newer words");
    expect(JSON.stringify(fixture.payloads[0])).toContain("original words");
    expect(JSON.stringify(fixture.payloads[0])).not.toContain("newer words");
    expect(fixture.releaseAttachments).not.toHaveBeenCalled();
  } finally {
    await act(async () => fixture.root.unmount());
  }
});

it.each([false, true])(
  "applies a committed receipt before refresh, unless its run already ended: %s",
  async (terminal) => {
    const outbox = await import("./thread-feedback");
    let delivered!: (attempt: SendAttempt) => void;
    const subscription = vi.spyOn(outbox, "subscribeDelivered").mockImplementation((listener) => {
      delivered = listener;
      return () => {};
    });
    const fixture = await chat([]);
    try {
      const receipt = { botId: "bot-1", runId: "receipt", taskId: "task" };
      if (terminal) fixture.terminalRunReceipts.current.add(receipt.runId);
      const before = fixture.snapRef.current;
      fixture.refresh.mockRejectedValueOnce(new Error("fixture refresh unavailable"));
      await act(async () =>
        delivered({
          payload: {
            originThreadKey: "bot-1",
            botTarget: "bot-1",
            reroutedToGroup: false,
            plan: {},
          },
          acceptedRun: receipt,
          apiBase: owner.apiBase,
          spaceId: "space",
          userId: "owner",
          cacheSession: "namespace",
        } as SendAttempt),
      );
      expect(fixture.refresh).toHaveBeenCalledOnce();
      if (terminal) expect(fixture.snapRef.current).toBe(before);
      else {
        expect(fixture.snapRef.current?.run).toMatchObject({
          id: receipt.runId,
          botId: receipt.botId,
          taskId: receipt.taskId,
          status: "queued",
        });
        expect(fixture.snapRef.current?.activeRuns).toEqual([fixture.snapRef.current?.run]);
      }
    } finally {
      await act(async () => fixture.root.unmount());
      subscription.mockRestore();
    }
  },
);

it.each(["account", "namespace", "server", "Space", "generation", "selection", "chat"])(
  "does not apply a delivery to a replacement %s",
  async (change) => {
    const outbox = await import("./thread-feedback");
    let delivered!: (attempt: SendAttempt) => void;
    const subscription = vi.spyOn(outbox, "subscribeDelivered").mockImplementation((listener) => {
      delivered = listener;
      return () => {};
    });
    const fixture = await chat([]);
    const attempt = {
      payload: { originThreadKey: "bot-1", botTarget: "bot-1", reroutedToGroup: false, plan: {} },
      acceptedRun: { botId: "bot-1", runId: "receipt", taskId: "task" },
      apiBase: owner.apiBase,
      spaceId: "space",
      userId: "owner",
      cacheSession: "namespace",
    } as SendAttempt;
    try {
      if (change === "account") fixture.snapshotOrigin.current.userId = "other";
      if (change === "namespace") fixture.snapshotOrigin.current.namespace = "other";
      if (change === "server") fixture.snapshotOrigin.current.apiBase = "https://other.example";
      if (change === "Space") fixture.snapshotOrigin.current.spaceId = "other";
      if (change === "generation") fixture.snapshotOrigin.current.sessionGeneration--;
      if (change === "selection") fixture.snapshotOrigin.current.selectionGeneration--;
      if (change === "chat") fixture.activeBotId.current = "other";
      await act(async () => delivered(attempt));
      expect(fixture.commitSnap).not.toHaveBeenCalled();
      expect(fixture.refresh).not.toHaveBeenCalled();
    } finally {
      await act(async () => fixture.root.unmount());
      subscription.mockRestore();
    }
  },
);
