// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useLingui } from "@lingui/react/macro";
import type { Space } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import { Plus } from "lucide-react";
import { IconTooltip } from "../../components/IconTooltip";

export const WORKSPACE_RAIL_WIDTH = 60;

export function WorkspaceRail({
  spaces,
  activeId,
  pendingId,
  onPrepare,
  onOpen,
  onCreate,
}: {
  spaces: readonly Pick<Space, "id" | "name" | "isDefault">[];
  activeId: string | undefined;
  pendingId: string | null;
  onPrepare: (spaceId: string) => void;
  onOpen: (spaceId: string) => void;
  onCreate?: () => void;
}) {
  const { t } = useLingui();
  const tooltipSide = document.documentElement.dir === "rtl" ? "left" : "right";
  const orderedSpaces = [...spaces].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return (
    <nav
      aria-label={t`Workspaces`}
      data-testid="workspace-rail"
      className="flex h-full shrink-0 flex-col items-center gap-2 border-e border-sidebar-border bg-sidebar px-1.5 pb-3 pt-12"
      style={{ width: WORKSPACE_RAIL_WIDTH }}
    >
      <div
        data-testid="workspace-rail-list"
        className="rk-scroll flex w-full min-h-0 flex-1 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto p-px"
      >
        {orderedSpaces.map((space) => {
          const active = space.id === activeId;
          const pending = space.id === pendingId;
          const prepare = () => {
            if (!active && !pending) onPrepare(space.id);
          };
          const initials = Array.from(space.name.trim()).slice(0, 2).join("").toLocaleUpperCase();
          return (
            <IconTooltip key={space.id} label={space.name} side={tooltipSide}>
              <Button
                type="button"
                variant={active ? "default" : pending ? "secondary" : "outline"}
                size="icon"
                className="app-no-drag size-11 shrink-0 rounded-xl text-xs font-semibold"
                aria-label={space.name}
                aria-current={active || undefined}
                aria-busy={pending || undefined}
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") prepare();
                }}
                onPointerDown={prepare}
                onFocus={prepare}
                onClick={() => {
                  if (!active) onOpen(space.id);
                }}
              >
                <span aria-hidden="true">{initials}</span>
              </Button>
            </IconTooltip>
          );
        })}
      </div>
      {onCreate ? (
        <IconTooltip label={t`Create workspace`} side={tooltipSide}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="app-no-drag size-11 shrink-0 rounded-xl"
            aria-label={t`Create workspace`}
            onClick={onCreate}
          >
            <Plus size={18} aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
    </nav>
  );
}
