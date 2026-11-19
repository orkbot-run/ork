// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 tests are preserved. Native renderer entry selection is an Ork addition.

import { createDb, createThreadMessageInTransaction } from "../../../packages/db/src/index";
import { pageViewerCode } from "../../../packages/page-kit/src/compile";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./renderer-test";

test("desktop chat keeps pinned agents, conversation and the context panel usable side by side", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem("orkbot.uiAppearance", "dark"));
  await signup(page, `desktop-preview-${Date.now()}@orkbot.test`, "password12", "Studio North");
  await completeOnboarding(page);
  const chief = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId: chief });
  await rpc(page, "bots/update", { botId: chief, color: "#FFFFFF" });
  const pinned = ["Chief", "Research", "Studio"];
  for (const name of [...pinned.slice(1), "Operations", "Quality Review", "Writing"]) {
    const bot = await rpc<{ id: string }>(page, "bots/create", {
      name,
      description: "",
      computerMode: "team",
    });
    if (name === "Research" || name === "Studio") {
      await rpc(page, "bots/update", {
        botId: bot.id,
        color: name === "Research" ? "#3EC5A8" : "#6A6BF5",
      });
    }
  }
  await page.reload();
  const sidebar = page.getByTestId("bots-sidebar");
  for (const name of pinned) {
    await sidebar.getByRole("button", { name: new RegExp(`^${name}`) }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  }
  const tiles = sidebar.locator('[data-roster-quick-access="true"]');
  await expect(tiles.getByRole("button")).toHaveCount(3);
  const yPositions = await tiles
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(yPositions).size).toBe(1);

  const { prisma, pool } = createDb(process.env.DATABASE_URL!);
  try {
    const {
      id: threadId,
      userId,
      spaceId,
    } = await prisma.thread.findUniqueOrThrow({ where: { botId: chief } });
    const title = "Friday handoff";
    const source = `export default function Handoff() {
      return <Page title="Friday handoff" summary="Decisions, owners and readiness for this week’s handoff.">
        <Section heading="Readiness">
          <Metrics metrics={[{ label: "Ready", value: "8" }, { label: "In review", value: "3" }, { label: "Needs owner", value: "2" }]} />
        </Section>
        <Section heading="Open decisions">
          <Text>Confirm deliverables with Studio and review the onboarding flow.</Text>
        </Section>
      </Page>;
    }`;
    await prisma.$transaction(async (tx) => {
      const handoff = await tx.page.create({
        data: {
          userId,
          spaceId,
          botId: chief,
          title,
          versions: { create: { version: 1, title, source, code: pageViewerCode(source) } },
        },
      });
      await createThreadMessageInTransaction(tx, {
        threadId,
        role: "user",
        blocks: [{ kind: "text", text: "What should we review before Friday’s handoff?" }],
      });
      await createThreadMessageInTransaction(tx, {
        threadId,
        botId: chief,
        role: "bot",
        markUnread: false,
        blocks: [
          {
            kind: "text",
            text: "I’ve pulled together the open decisions. The release checklist is ready for review.",
          },
          { kind: "page", pageId: handoff.id, version: 1, title },
        ],
      });
      await createThreadMessageInTransaction(tx, {
        threadId,
        botId: chief,
        role: "bot",
        markUnread: false,
        blocks: [
          {
            kind: "text",
            text: "**Before Friday**\n\n- Confirm the final deliverables with Studio.\n- Ask Quality Review to check the onboarding flow.\n- Add owners to the two open accessibility items.",
          },
        ],
      });
    });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }

  await page.reload();
  await openBotPanelTab(page, "Computer");
  const panel = page.getByTestId("side-panel");
  await expect(panel.getByRole("tab", { name: "Computer", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByTestId("transcript").getByText("Before Friday", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId("page-card").getByRole("button", { name: "Open Friday handoff" }),
  ).toBeVisible();
  await expect(
    page
      .locator('iframe[title="Friday handoff"]')
      .contentFrame()
      .locator("iframe#preview")
      .contentFrame()
      .getByText("Needs owner"),
  ).toBeVisible();
  await expect(page.getByTestId("composer-bar")).toBeVisible();
  await captureScreenshot(page, testInfo, "ork-desktop-preview");

  await panel.getByRole("tab", { name: "Pages", exact: true }).click();
  await expect(panel.getByRole("tab", { name: "Pages", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await panel.getByRole("button", { name: "Close panel" }).click();
  await tiles.getByRole("button", { name: /^Research/ }).click();
  await expect(page.getByPlaceholder("Message Research")).toBeVisible();
});

test("the chat header floats over the transcript", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `chat-header-${Date.now()}@orkbot.test`, "password12", "Sample");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });

  const transcript = page.getByTestId("transcript");
  for (let item = 1; item <= 8; item++) {
    const text = `Question ${item}: what is the status of launch item ${item}? The draft is reviewed and the checklist is complete.`;
    await rpc(page, "threads/send", { botId, text });
  }
  await page.reload();
  await expect(transcript.getByText(/^Question 8:/).first()).toBeVisible();

  const header = await page.getByTestId("bot-settings-trigger").boundingBox();
  const scroller = await transcript.boundingBox();
  if (!header || !scroller) throw new Error("missing chat layout");
  // Messages scroll under the floating header rather than stopping below a bar.
  expect(scroller.y).toBeLessThan(header.y);
  const gapHitsTranscript = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="transcript"]')),
    { x: scroller.x + scroller.width / 4, y: header.y + header.height / 2 },
  );
  expect(gapHitsTranscript).toBe(true);

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `chat-header-floating-${theme}`);
  }

  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = await transcript
    .getByText(/^Question 1:/)
    .first()
    .boundingBox();
  if (!first) throw new Error("missing first message");
  expect(first.y).toBeGreaterThan(header.y + header.height);
});
