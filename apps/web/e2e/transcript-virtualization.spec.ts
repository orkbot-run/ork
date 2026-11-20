// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createDb } from "../../../packages/db/src/index";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./renderer-test";

test("a long transcript preserves paging, offscreen reply jumps, and find in chat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "orkbotDesktop", {
      value: {
        platform: "linux",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
      },
    });
  });
  await signup(page, `virtual-transcript-${Date.now()}@orkbot.test`, "password12", "Reader");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });
  const idFor = (seq: number) => `virtual-${botId}-${seq}`;
  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
    const count = 180;
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { threadId: thread.id } }),
      prisma.message.createMany({
        data: Array.from({ length: count }, (_, index) => {
          const seq = index + 1;
          return {
            id: idFor(seq),
            threadId: thread.id,
            seq,
            role: seq % 2 === 0 ? "user" : "bot",
            botId: seq % 2 === 0 ? undefined : botId,
            blocks: [
              { kind: "text", text: `History item ${seq}\n\n${"Details.\n\n".repeat(seq % 5)}` },
            ],
            replyToMessageId: seq === count ? idFor(120) : undefined,
            searchTokens: [],
          };
        }),
      }),
      prisma.thread.update({
        where: { id: thread.id },
        data: { nextMessageSeq: count + 1, lastReadSeq: count, unread: false },
      }),
    ]);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  await page.reload();
  const transcript = page.getByTestId("transcript");
  const mounted = transcript.locator("[data-chat-row]");
  const row = (seq: number) => transcript.locator(`[data-message-id="${idFor(seq)}"]`);
  const latest = page.getByRole("button", { name: "Jump to latest" });
  const earlier = transcript.getByRole("button", { name: "Load earlier messages" });
  await expect(row(180)).toBeInViewport();
  await expect(row(120)).toHaveCount(0);
  await expect.poll(() => mounted.count()).toBeLessThan(32);

  const requestedAround: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/rpc/threads/messages") &&
      request.postData()?.includes('"around"')
    ) {
      requestedAround.push(request.url());
    }
  });
  await row(180).getByTestId("reply-parent-preview").click();
  await expect(row(120)).toBeInViewport();
  expect(requestedAround).toHaveLength(0);
  await latest.click();
  await expect(row(180)).toBeInViewport();

  await transcript.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(row(81)).toBeInViewport();
  const initialTop = (await row(81).boundingBox())!.y;
  await earlier.click();
  await expect(earlier).toHaveCount(0);
  await expect(row(81)).toBeInViewport();
  await expect
    .poll(async () => Math.abs((await row(81).boundingBox())!.y - initialTop))
    .toBeLessThan(2);
  await expect.poll(() => mounted.count()).toBeLessThan(32);

  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await find.fill("History item 4");
  await expect(page.getByTestId("chat-find").getByText(/^1\/\d+$/)).toBeVisible();
  await expect(row(4)).toBeInViewport();
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  await expect(row(4)).toBeInViewport();
  await expect.poll(() => mounted.count()).toBeLessThan(32);

  await latest.click();
  await expect(row(180)).toBeInViewport();
  const appended = "A new message in the virtual transcript";
  await rpc(page, "threads/send", { botId, text: appended, clientNonce: idFor(181) });
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: appended }),
  ).toBeInViewport();
});
