// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ArchivedBotList } from "../components/archived-bot-list";
import type { MobileBot, MobileGroup } from "./api";

const native = vi.hoisted(() => ({
  list: null as null | {
    data: Array<{ kind: string; bot?: MobileBot; group?: MobileGroup }>;
    keyExtractor: (item: unknown) => string;
    renderItem: (row: { item: unknown; index: number }) => ReactNode;
  },
  menus: [] as Array<{ onPressAction: (event: unknown) => void }>,
}));
vi.mock("react-native", () => ({
  FlatList: (props: NonNullable<typeof native.list>) => {
    native.list = props;
    return null;
  },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: (props: { children?: ReactNode; onPressAction: (event: unknown) => void }) => {
    native.menus.push(props);
    return <div>{props.children}</div>;
  },
}));
vi.mock("../components/long-press-menu", () => ({
  LongPressMenu: (props: {
    children: (onLongPress: () => void) => ReactNode;
    onPressAction: (event: unknown) => void;
  }) => {
    native.menus.push(props);
    return <div>{props.children(() => {})}</div>;
  },
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/row-accessories", () => ({ Chevron: () => null }));
vi.mock("./native", () => ({ native: {}, useResolvedAppearance: () => "light" }));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));

it("passes the full archive to the virtual list without eagerly mounting its rows", () => {
  const bots = Array.from(
    { length: 500 },
    (_, index) => ({ id: `bot-${index}`, name: `Bot ${index}` }) as MobileBot,
  );
  const group = { id: "bot-0", name: "Group" } as MobileGroup;
  const onRestore = vi.fn();
  const onDelete = vi.fn();
  const onRestoreGroup = vi.fn();
  renderToStaticMarkup(
    <ArchivedBotList
      bots={bots}
      groups={[group]}
      pending={false}
      onOpen={vi.fn()}
      onRestore={onRestore}
      onDelete={onDelete}
      onRestoreGroup={onRestoreGroup}
    />,
  );
  expect(native.menus).toHaveLength(0);
  const list = native.list!;
  expect(list.data).toHaveLength(501);
  expect(list.keyExtractor(list.data[0])).toBe("bot:bot-0");
  expect(list.keyExtractor(list.data[500])).toBe("group:bot-0");
  expect(renderToStaticMarkup(list.renderItem({ item: list.data[0], index: 0 }))).toContain(
    "Bot 0",
  );
  native.menus[0]!.onPressAction({ nativeEvent: { event: "restore" } });
  native.menus[0]!.onPressAction({ nativeEvent: { event: "delete" } });
  expect(onRestore).toHaveBeenCalledWith(bots[0]);
  expect(onDelete).toHaveBeenCalledWith(bots[0]);
  expect(renderToStaticMarkup(list.renderItem({ item: list.data[500], index: 500 }))).toContain(
    "Group",
  );
  native.menus[1]!.onPressAction({});
  expect(onRestoreGroup).toHaveBeenCalledWith(group);
});
