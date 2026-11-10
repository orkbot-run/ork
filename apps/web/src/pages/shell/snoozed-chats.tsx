// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@orkbot/ui-web";
import { useState } from "react";
import { createSpaceRpc } from "../../lib/rpc";

export type SnoozedChat = {
  kind: "bot" | "group";
  id: string;
  name: string;
  spaceId: string;
  until: string;
};

export function SnoozedChats({
  chats,
  refresh,
}: {
  chats: SnoozedChat[];
  refresh: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (chats.length === 0) return null;
  async function wake(chat: SnoozedChat) {
    setBusy(chat.id);
    setFailed(false);
    try {
      await createSpaceRpc(chat.spaceId).threads.unsnooze(
        chat.kind === "bot" ? { botId: chat.id } : { groupId: chat.id },
      );
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-2 border-t border-border pt-2"
      data-testid="snoozed-chats"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-[13.5px] text-muted-foreground hover:bg-sidebar-accent">
        <span>
          <Trans>Snoozed</Trans>
        </span>
        <span>{chats.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col">
        {chats.map((chat) => (
          <div
            key={`${chat.kind}:${chat.id}`}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2"
          >
            <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
              {chat.name}
            </span>
            <time className="text-xs text-muted-foreground" dateTime={chat.until}>
              {new Date(chat.until).toLocaleString(undefined, {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy !== null}
              aria-label={t`Wake ${chat.name}`}
              onClick={() => void wake(chat)}
            >
              <Trans>Wake</Trans>
            </Button>
          </div>
        ))}
        {failed ? (
          <p role="alert" className="px-2.5 text-sm text-destructive">
            <Trans>Something went wrong. Try again.</Trans>
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
