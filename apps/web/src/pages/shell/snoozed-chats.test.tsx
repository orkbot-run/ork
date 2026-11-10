// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ unsnooze: vi.fn(async () => ({ ok: true })), space: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  createSpaceRpc: (spaceId: string) => {
    calls.space(spaceId);
    return { threads: { unsnooze: calls.unsnooze } };
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...args: string[]) =>
      parts.reduce((out, part, i) => out + part + (args[i] ?? ""), ""),
  }),
}));
vi.mock("@orkbot/ui-web", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

import { SnoozedChats } from "./snoozed-chats";

it("wakes the selected chat in its own space and refreshes", async () => {
  const container = document.createElement("div");
  const view = createRoot(container);
  const refresh = vi.fn(async () => undefined);
  await act(async () =>
    view.render(
      <SnoozedChats
        chats={[
          {
            kind: "group",
            id: "group-1",
            name: "Team",
            spaceId: "other-space",
            until: "2030-01-01T10:00:00Z",
          },
        ]}
        refresh={refresh}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Wake Team"]')!.click(),
  );
  expect(calls.space).toHaveBeenCalledWith("other-space");
  expect(calls.unsnooze).toHaveBeenCalledWith({ groupId: "group-1" });
  expect(refresh).toHaveBeenCalledOnce();
  act(() => view.unmount());
});
