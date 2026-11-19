// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useLingui } from "@lingui/react/macro";
import { BotAvatar, GroupAvatar, Skeleton } from "@orkbot/ui-web";
import { matchPath, useLocation } from "react-router-dom";
import type { WorkspaceNavigationPreview } from "../../lib/bootstrap";
import { useShellNavigation } from "./use-shell-navigation";
import { useOpenSpaceChat, workspaceChatPath } from "./use-space-switch";
import { WorkspaceRail } from "./workspace-rail";

/** The destination's known navigation while the scoped bootstrap is still loading. */
export function WorkspaceOpening({
  spaceId,
  preview,
}: {
  spaceId: string;
  preview: WorkspaceNavigationPreview;
}) {
  const { t } = useLingui();
  const { pathname } = useLocation();
  const navigation = useShellNavigation();
  const { openSpaceChat, preloadSpaceChat } = useOpenSpaceChat({
    ...navigation,
    bootstrapSpaceId: spaceId,
    userId: preview.userId,
    closeMobileSidebar: () => {},
  });
  const space = preview.spaces.find((entry) => entry.id === spaceId);
  const botId = matchPath("/app/:botId", pathname)?.params.botId;
  const groupId = matchPath("/app/g/:groupId", pathname)?.params.groupId;
  const title =
    space?.bots.find((bot) => bot.id === botId)?.name ??
    space?.groups.find((group) => group.id === groupId)?.name ??
    space?.name;

  return (
    <div data-testid="workspace-opening" className="flex h-full min-h-0 bg-background">
      <WorkspaceRail
        spaces={preview.spaces}
        activeId={spaceId}
        pendingId={null}
        onPrepare={(id) => {
          const entry = preview.spaces.find((row) => row.id === id);
          if (entry) preloadSpaceChat(id, workspaceChatPath(preview.userId, entry));
        }}
        onOpen={(id) => {
          const entry = preview.spaces.find((row) => row.id === id);
          if (entry) openSpaceChat(id, workspaceChatPath(preview.userId, entry), preview.spaces);
        }}
      />
      <aside
        data-testid="bots-sidebar"
        className="rk-scroll hidden w-64 shrink-0 overflow-y-auto border-e border-sidebar-border bg-sidebar px-2 pt-12 md:block"
      >
        <div className="truncate px-2 py-2 text-sm text-muted-foreground">{space?.name}</div>
        <ul className="flex flex-col gap-1">
          {space?.bots.map((bot) => (
            <li
              key={bot.id}
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm"
            >
              <BotAvatar
                color={bot.color}
                avatarSet={bot.avatarSet}
                avatarSeed={bot.avatarSeed}
                size={28}
              />
              <span className="truncate">{bot.name}</span>
            </li>
          ))}
          {space?.groups.map((group) => (
            <li
              key={group.id}
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm"
            >
              <GroupAvatar members={group.members} size={28} />
              <span className="truncate">{group.name}</span>
            </li>
          ))}
        </ul>
      </aside>
      <main aria-busy="true" className="relative min-w-0 flex-1 bg-background">
        <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 h-3" />
        <h1 className="truncate px-5 py-5 text-center text-sm font-semibold">{title}</h1>
        <div role="status" className="sr-only">{t`Loading…`}</div>
        <div aria-hidden="true" className="mx-4 mt-6 flex flex-col gap-3 md:mx-7">
          <Skeleton className="h-8 w-1/3 self-end rounded-xl" />
          <Skeleton className="h-8 w-2/5 rounded-xl" />
        </div>
      </main>
    </div>
  );
}
