// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 peer projection is preserved. Outgoing receipt grouping is an Ork addition.

import type { MessageBlock } from "@orkbot/contracts";
import { clampBotMessage } from "./bot-messages.js";
import type { FoldedTranscript } from "./message-visibility.js";

export type PeerRecipient = {
  peerBotId: string;
  peerBotName: string;
};

export type PeerExchange = PeerRecipient & {
  count: number;
  direction: "sent" | "received";
  recipients?: PeerRecipient[];
};

type Message = {
  id: string;
  runId?: string;
  role?: string;
  blocks: readonly MessageBlock[];
};

function peerReceipt(blocks: readonly MessageBlock[]) {
  const block = blocks.find(
    (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (block?.kind === "bot_message_sent")
    return { peerBotId: block.toBotId, peerBotName: block.toBotName, direction: "sent" as const };
  if (block?.kind === "bot_message_received")
    return {
      peerBotId: block.fromBotId,
      peerBotName: block.fromBotName,
      direction: "received" as const,
    };
  return undefined;
}

/** Match exact observable payloads within one run and peer, never similar prose across runs. */
export function unreturnedPeerReplies<T extends Message>(
  transcript: FoldedTranscript<T>,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  const receipts = new Map<string, Map<string, Map<string, number>>>();
  for (const message of transcript.messages) {
    if (!message.runId) continue;
    for (const block of message.blocks) {
      if (block.kind !== "bot_message_sent") continue;
      let peers = receipts.get(message.runId);
      if (!peers) {
        peers = new Map();
        receipts.set(message.runId, peers);
      }
      let counts = peers.get(block.toBotId);
      if (!counts) {
        counts = new Map();
        peers.set(block.toBotId, counts);
      }
      const text = clampBotMessage(block.text);
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
  }
  for (const marker of transcript.messages) {
    const peer = peerReceipt(marker.blocks);
    const replies = transcript.folded.get(marker.id);
    if (!peer || !replies) continue;
    const echoes = marker.runId ? receipts.get(marker.runId)?.get(peer.peerBotId) : undefined;
    result.set(
      marker.id,
      replies.filter((reply) => {
        if (reply.role !== "bot") return false;
        const content = reply.blocks.filter(
          (b) => b.kind === "text" || b.kind === "file" || b.kind === "image",
        );
        if (!content.length) return false;
        // Attachments are not represented by a text echo.
        if (content.some((b) => b.kind !== "text")) return true;
        const text = clampBotMessage(
          content.map((b) => (b.kind === "text" ? b.text : "")).join("\n"),
        );
        const count = echoes?.get(text) ?? 0;
        if (!count) return true;
        echoes?.set(text, count - 1);
        return false;
      }),
    );
  }
  return result;
}

/** Project only visible rows; callers remove invisible tool/reaction rows before grouping. */
export function peerExchangeLines<T extends Message>(transcript: FoldedTranscript<T>) {
  const lines = new Map<string, PeerExchange>();
  const lineOf = new Map<string, string>();
  const unreturned = unreturnedPeerReplies(transcript);
  let previous: PeerExchange | undefined;
  let firstId: string | undefined;
  let outgoing: { id: string; recipients: PeerRecipient[]; count: number }[] = [];

  function addReceipt(id: string, exchange: PeerExchange, standalone: boolean) {
    if (standalone && previous?.peerBotId === exchange.peerBotId && firstId) {
      previous.peerBotName = exchange.peerBotName;
      previous.count += exchange.count;
      lineOf.set(id, firstId);
      return firstId;
    }
    lines.set(id, exchange);
    lineOf.set(id, id);
    previous = standalone ? exchange : undefined;
    firstId = standalone ? id : undefined;
    return id;
  }

  function flushOutgoing() {
    const first = outgoing[0];
    if (!first) return;
    const recipients = new Map<string, PeerRecipient>();
    let count = 0;
    for (const receipt of outgoing) {
      count += receipt.count;
      for (const peer of receipt.recipients) recipients.set(peer.peerBotId, peer);
    }
    const peers = [...recipients.values()];
    const primary = peers[0]!;
    const exchange: PeerExchange = { ...primary, count, direction: "sent" };
    if (peers.length > 1) exchange.recipients = peers;
    const line = addReceipt(first.id, exchange, !exchange.recipients);
    for (const receipt of outgoing) lineOf.set(receipt.id, line);
    outgoing = [];
  }

  for (const message of transcript.messages) {
    const receipt = peerReceipt(message.blocks);
    if (receipt && message.blocks.every((block) => block.kind === "bot_message_sent")) {
      outgoing.push({
        id: message.id,
        recipients: message.blocks.map((block) => ({
          peerBotId: block.toBotId,
          peerBotName: block.toBotName,
        })),
        count: message.blocks.length + (unreturned.get(message.id)?.length ?? 0),
      });
      continue;
    }
    flushOutgoing();
    if (!receipt) {
      previous = undefined;
      continue;
    }
    const count =
      message.blocks.filter(
        (b) => b.kind === "bot_message_sent" || b.kind === "bot_message_received",
      ).length + (unreturned.get(message.id)?.length ?? 0);
    const standalone = message.blocks.every((block) => block.kind === "bot_message_received");
    addReceipt(message.id, { ...receipt, count }, standalone);
  }
  flushOutgoing();
  return { lines, lineOf };
}

/** Keeps each recipient actionable while respecting the locale's list and sentence order. */
export function peerReceiptList(
  recipients: readonly PeerRecipient[],
  locale: string,
  label: (names: string) => string,
): ({ text: string } | { recipient: PeerRecipient })[] {
  const namesInOrder = recipients.map((recipient) => recipient.peerBotName);
  const formatter =
    typeof Intl.ListFormat === "function" ? new Intl.ListFormat(locale || "en") : undefined;
  const parts =
    formatter?.formatToParts?.(namesInOrder) ??
    namesInOrder.flatMap((value, index) => [
      ...(index ? [{ type: "literal", value: ", " }] : []),
      { type: "element", value },
    ]);
  const names = parts.map((part) => part.value).join("");
  const { before, after } = splitPeerLabel(label(names), names);
  let index = 0;
  return [
    { text: before },
    ...parts.map((part) =>
      part.type === "element" ? { recipient: recipients[index++]! } : { text: part.value },
    ),
    { text: after },
  ];
}

/** The final translation decides avatar placement, including locales with trailing words. */
export function splitPeerLabel(label: string, peerName: string) {
  const index = peerName ? label.lastIndexOf(peerName) : -1;
  return index < 0
    ? { before: "", name: "", after: label }
    : {
        before: label.slice(0, index),
        name: peerName,
        after: label.slice(index + peerName.length),
      };
}
