// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans } from "@lingui/react/macro";
import { parseMeetingLink } from "@orkbot/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { Meetings } from "./meetings";

/** A plain URL offers a consent flow; pasting never joins or schedules a meeting. */
export function MeetingLinkSuggestion({ botId, value }: { botId: string; value: string }) {
  const link = parseMeetingLink(value);
  const queries = useSpaceQueries();
  const availability = useQuery({
    ...queries.meetings.status.queryOptions(),
    enabled: Boolean(link),
    staleTime: 60_000,
  });
  const [open, setOpen] = useState(false);
  if (!link || !availability.data?.enabled) return null;
  return (
    <>
      <div className="mb-2 rounded-xl border border-border bg-card p-3 text-sm flex flex-wrap items-center justify-between gap-2">
        <span>
          <Trans>Invite your bot to this meeting?</Trans>
        </span>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          <Trans>Review meeting invitation</Trans>
        </Button>
      </div>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                <Trans>Meetings</Trans>
              </DialogTitle>
              <DialogDescription>
                <Trans>Review the link and participant consent before inviting your bot.</Trans>
              </DialogDescription>
            </DialogHeader>
            <Meetings botId={botId} initialUrl={link.url} />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
