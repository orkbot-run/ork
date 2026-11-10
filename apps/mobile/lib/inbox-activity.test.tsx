// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (value: string, params?: { name: string }) =>
      params ? value.replace("{name}", params.name) : value,
  }),
}));
vi.mock("./native", () => ({ useThemedStyles: () => ({}) }));
vi.mock("./activity", () => ({
  activityPreview: () => "",
  activityStatusLabel: (status: string) => status,
  formatActivityRelativeTime: () => "",
}));
vi.mock("../components/home-styles", () => ({ createHomeStyles: () => ({}) }));
vi.mock("../components/bot-avatar", () => ({ BotAvatar: () => <i /> }));
vi.mock("../components/group-avatar", () => ({ GroupAvatar: () => <i /> }));
vi.mock("../components/inbox-rows", () => ({
  FALLBACK_COLOR: "orange",
  SectionToggle: ({ title, collapsed }: { title: string; collapsed: boolean }) => (
    <button type="button" aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`} />
  ),
  ConversationRow: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("../components/inbox-swipe-row", () => ({
  InboxSwipeRow: ({
    children,
    onAction,
  }: {
    children: ReactNode;
    onAction: (action: string) => void;
  }) => (
    <div>
      {children}
      <button type="button" onClick={() => onAction("archive")}>
        Archive
      </button>
    </div>
  ),
}));

import { ActivitySection } from "../components/inbox-activity";

it("opens Needs attention and folds Working and Unread until the user opens them", () => {
  const markup = renderToStaticMarkup(
    createElement(ActivitySection, {
      activity: {
        active: [
          { runId: "ask", botId: "marketing", botName: "Marketing", status: "waiting_input" },
          { runId: "work", botId: "research", botName: "Research", status: "running" },
        ] as never,
        recent: [],
      },
      bots: [{ id: "writer", name: "Writer", status: "idle", unread: true }] as never,
      groups: [],
      toggledSections: new Set(["activity:unread"]),
      onToggleSection: () => undefined,
      openChat: () => undefined,
    }),
  );
  expect(markup).toContain('aria-label="Collapse Needs attention"');
  expect(markup).toContain('aria-label="Expand Working"');
  expect(markup).toContain('aria-label="Collapse Unread"');
  expect(markup).toContain("Marketing");
  expect(markup).not.toContain("Research");
  expect(markup).toContain("Writer");
});

it("offers the same archive action on activity rows", () => {
  const archive = vi.fn();
  const bot = {
    id: "marketing",
    name: "Marketing",
    status: "waiting_input",
    color: "red",
    unread: false,
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(ActivitySection, {
        activity: {
          active: [
            { runId: "ask", botId: bot.id, botName: bot.name, status: "waiting_input" },
          ] as never,
          recent: [],
        },
        bots: [bot] as never,
        groups: [],
        toggledSections: new Set<string>(),
        onToggleSection: () => undefined,
        openChat: () => undefined,
        botAction: archive,
        groupAction: vi.fn(),
        organizeFromMenu: vi.fn(),
        editSectionFromMenu: vi.fn(),
      }),
    ),
  );
  act(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Archive")!
      .click(),
  );
  expect(archive).toHaveBeenCalledWith("archive", bot);
  act(() => root.unmount());
});
