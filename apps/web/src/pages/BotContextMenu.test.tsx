// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: string[]) =>
      parts.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("@orkbot/ui-web", () => {
  const Box = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ContextMenuContent: Box,
    ContextMenuItem: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    ContextMenuSeparator: () => <hr />,
    ContextMenuSub: Box,
    ContextMenuSubContent: Box,
    ContextMenuSubTrigger: Box,
  };
});

import { BotContextMenu } from "./BotContextMenu";

it("maps all four snooze menu choices to their presets", () => {
  const onSnooze = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const noop = () => undefined;
  act(() =>
    root.render(
      <BotContextMenu
        bot={{ name: "Test", pinned: false, sectionId: null, unread: false }}
        sections={[]}
        onClose={noop}
        onTogglePinned={noop}
        onMoveToSection={noop}
        onCreateSection={noop}
        onToggleUnread={noop}
        onEdit={noop}
        onDuplicate={noop}
        onClear={noop}
        onArchive={noop}
        onDelete={noop}
        onSnooze={onSnooze}
      />,
    ),
  );
  for (const text of ["1 hour", "3 hours", "Tomorrow at 9", "Monday at 9"])
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === text)!
        .click(),
    );
  expect(onSnooze.mock.calls).toEqual([["hour_1"], ["hour_3"], ["tomorrow_9"], ["monday_9"]]);
  act(() => root.unmount());
});
