// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 markers are preserved. Grouped outgoing receipts are an Ork addition.

import type { BotAvatarSet } from "@orkbot/contracts";
import type { PeerRecipient } from "@orkbot/core";
import { peerReceiptList, splitPeerLabel } from "@orkbot/core";
import type { GroupAvatarMember } from "@orkbot/ui-web";
import { BotAvatar, GroupAvatar } from "@orkbot/ui-web";

export function CollaborationMarker({
  color,
  avatarSet,
  identity,
  label,
  peerName,
  onClick,
}: {
  color: string;
  avatarSet?: BotAvatarSet;
  identity: string;
  label: string;
  peerName: string;
  onClick: () => void;
}) {
  const parts = splitPeerLabel(label, peerName);
  return (
    <div className="flex min-w-0 max-w-full justify-center py-1">
      <button
        type="button"
        data-testid="peer-receipt-chip"
        aria-label={label}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {parts.before ? <span className="whitespace-pre-wrap">{parts.before}</span> : null}
        <BotAvatar avatarSet={avatarSet} color={color} identity={identity} size={16} />
        {parts.name ? (
          <span dir="auto" className="truncate font-medium">
            {parts.name}
          </span>
        ) : null}
        {parts.after ? <span className="whitespace-pre-wrap">{parts.after}</span> : null}
      </button>
    </div>
  );
}

export function CollaborationRecipients({
  recipients,
  locale,
  label,
  peerBot,
  onOpen,
}: {
  recipients: PeerRecipient[];
  locale: string;
  label: (names: string) => string;
  peerBot: (id: string) => { color: string; avatarSet?: BotAvatarSet } | undefined;
  onOpen: (recipient: PeerRecipient) => void;
}) {
  return (
    <div
      data-testid="peer-receipt-group"
      className="min-w-0 px-2.5 py-2 text-center text-[13px] text-muted-foreground"
    >
      {peerReceiptList(recipients, locale, label).map((part) => {
        if ("text" in part) return part.text;
        const { recipient } = part;
        const bot = peerBot(recipient.peerBotId);
        return (
          <button
            key={recipient.peerBotId}
            type="button"
            onClick={() => onOpen(recipient)}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md align-middle font-medium hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            {bot ? (
              <BotAvatar
                avatarSet={bot.avatarSet}
                color={bot.color}
                identity={recipient.peerBotId}
                size={16}
              />
            ) : null}
            <span dir="auto" className="wrap-anywhere min-w-0 text-start">
              {recipient.peerBotName}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The working bot with what it is doing right now, such as its current tool call. */
export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div role="status" className="flex min-h-10 min-w-0 items-center gap-2.5 px-1">
      <GroupAvatar members={bots} size={28} />
      <span dir="auto" className="min-w-0 truncate text-[15px] text-muted-foreground text-shimmer">
        {label}
      </span>
    </div>
  );
}
