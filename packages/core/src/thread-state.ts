// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 thread reduction is preserved. Shared native reconciliation follows LICENSE.md.

import type {
  ComputerStatus,
  ProductEvent,
  Run,
  RunStatus,
  RunTrigger,
  ThreadMessage,
  ThreadSnapshot,
} from "@orkbot/contracts";
import { RUN_TRIGGERS } from "@orkbot/contracts";
import {
  isRunTerminalEvent,
  progressMessageId,
  reduceLiveMessageBlocks,
  runFailureError,
  settleRunSubagents,
  stopsRunHelpers,
  subagentBlockFromPayload,
} from "./events.js";
import { mergeThreadHistory, upsertMessageById } from "./message-pages.js";
import { replyMetadata } from "./message-replies.js";
import { runRoutineDisplayName } from "./routine-work.js";
import { isActive, isBackgroundRunTrigger, QUEUE_HOLDING_RUN_STATUSES } from "./run-state.js";
import { takeLiveMessage, updateCloudAgentMessages } from "./thread-message-updates.js";

/** Saved and live views may predate a full record without discarding any known server fields. */
export type ClientThreadRun = Pick<Run, "id"> &
  Partial<Omit<Run, "id" | "status">> & { status: string };
export type ClientThreadMessage = Omit<ThreadMessage, "threadId" | "seq" | "createdAt"> &
  Partial<Pick<ThreadMessage, "threadId" | "seq" | "createdAt">>;
export type ClientThreadComputer = Pick<
  ComputerStatus,
  "state" | "controlHolder" | "screenAvailable" | "mode" | "busyBotName"
> &
  Partial<ComputerStatus>;
export type ClientThreadSnapshot = Omit<
  ThreadSnapshot,
  "cursor" | "messages" | "run" | "activeRuns" | "computer"
> & {
  cursor?: number;
  messages: ClientThreadMessage[];
  run: ClientThreadRun | null;
  activeRuns?: ClientThreadRun[];
  computer?: ClientThreadComputer;
};
export type ClientThreadEvent = {
  type: string;
  id?: string;
  createdAt?: string;
  botId?: string;
  runId?: string;
  threadId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
};

export type ThreadSendReceipt = {
  botId: string;
  runId: string;
  taskId: string;
  createdAt?: string;
};

const runTriggers = new Set<string>(RUN_TRIGGERS);

function runFromStartedEvent(
  event: ClientThreadEvent,
  previous: ClientThreadRun | undefined,
  snapshot: ClientThreadSnapshot,
): ClientThreadRun {
  const trigger = event.payload?.trigger;
  const routineId =
    typeof event.payload?.routineId === "string"
      ? event.payload.routineId
      : event.payload?.routineId === null
        ? null
        : (previous?.routineId ?? null);
  const sameSource =
    !previous ||
    ((!previous.botId || previous.botId === (event.botId ?? previous.botId)) &&
      (!previous.threadId || previous.threadId === (event.threadId ?? snapshot.threadId)));
  const keepName =
    sameSource &&
    routineId === previous?.routineId &&
    (typeof trigger !== "string" || trigger === previous?.trigger);
  const routineName = Object.hasOwn(event.payload ?? {}, "routineName")
    ? {
        routineName:
          routineId && sameSource ? runRoutineDisplayName(event.payload?.routineName) : null,
      }
    : previous?.routineName !== undefined
      ? { routineName: keepName ? previous.routineName : null }
      : {};
  return {
    ...previous,
    ...routineName,
    id: event.runId ?? previous?.id ?? event.id ?? "",
    botId: event.botId ?? previous?.botId,
    threadId: event.threadId ?? snapshot.threadId,
    taskId: previous?.taskId ?? event.runId ?? event.id,
    userId: previous?.userId,
    status: "running",
    trigger:
      typeof trigger === "string" && runTriggers.has(trigger)
        ? (trigger as RunTrigger)
        : (previous?.trigger ?? "user"),
    routineId,
    modelProvider: previous?.modelProvider ?? null,
    modelId: previous?.modelId ?? null,
    error: null,
    startedAt: previous?.startedAt ?? event.createdAt,
    completedAt: null,
    createdAt: previous?.createdAt ?? event.createdAt,
  };
}

export function activeThreadRuns(
  snapshot: ThreadSnapshot | null,
): NonNullable<ThreadSnapshot["activeRuns"]>;
export function activeThreadRuns(
  snapshot: ClientThreadSnapshot | null,
): NonNullable<ClientThreadSnapshot["activeRuns"]>;
export function activeThreadRuns(
  snapshot: ClientThreadSnapshot | null,
): NonNullable<ClientThreadSnapshot["activeRuns"]> {
  return snapshot?.activeRuns ?? (snapshot?.run ? [snapshot.run] : []);
}

/**
 * Reflect a committed direct-message send before its follow-up snapshot arrives.
 *
 * threads.send returns only after the message and run are durable. Keeping that
 * receipt prevents a transient snapshot/SSE interruption from showing a stored
 * user bubble with no working state. A matching live run always wins, and the
 * next durable event or refresh still supplies the authoritative status.
 */
export function applyThreadSendReceipt(
  snapshot: ThreadSnapshot | null,
  receipt: ThreadSendReceipt,
  terminalRunIds?: ReadonlySet<string>,
): ThreadSnapshot | null;
export function applyThreadSendReceipt(
  snapshot: ClientThreadSnapshot | null,
  receipt: ThreadSendReceipt,
  terminalRunIds?: ReadonlySet<string>,
): ClientThreadSnapshot | null;
export function applyThreadSendReceipt(
  snapshot: ClientThreadSnapshot | null,
  receipt: ThreadSendReceipt,
  terminalRunIds: ReadonlySet<string> = new Set(),
): ClientThreadSnapshot | null {
  if (
    !snapshot ||
    snapshot.groupId ||
    snapshot.botId !== receipt.botId ||
    snapshot.run?.id === receipt.runId ||
    terminalRunIds.has(receipt.runId)
  ) {
    return snapshot;
  }
  const currentRuns = activeThreadRuns(snapshot);
  if (currentRuns.some((run) => QUEUE_HOLDING_RUN_STATUSES.some((s) => s === run.status)))
    return snapshot;
  const createdAt = receipt.createdAt ?? new Date().toISOString();
  const run: ClientThreadRun = {
    id: receipt.runId,
    botId: receipt.botId,
    threadId: snapshot.threadId,
    taskId: receipt.taskId,
    status: "queued",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt,
  };
  return {
    ...snapshot,
    run,
    activeRuns: [...currentRuns.filter((r) => isActive(r.status as RunStatus)), run],
  };
}

/** Reason the newest run stopped, until the reader dismisses that run's failure. */
export function threadRunError(
  snapshot: ClientThreadSnapshot | null,
  dismissedRunIds?: ReadonlySet<string>,
): string | null {
  const run = snapshot?.run;
  if (run?.status !== "failed" || dismissedRunIds?.has(run.id)) return null;
  return run.error ?? null;
}

export function clearActiveThreadRuns(snapshot: ThreadSnapshot): ThreadSnapshot;
export function clearActiveThreadRuns(snapshot: ClientThreadSnapshot): ClientThreadSnapshot;
export function clearActiveThreadRuns(snapshot: ClientThreadSnapshot): ClientThreadSnapshot {
  const runIds = new Set(activeThreadRuns(snapshot).map((run) => run.id));
  const computer = snapshot.computer?.busyBotName
    ? { ...snapshot.computer, busyBotName: null }
    : snapshot.computer;
  return {
    ...snapshot,
    run: null,
    activeRuns: [],
    messages: snapshot.messages.filter(
      (message) =>
        !message.runId || !runIds.has(message.runId) || !message.id.startsWith("progress:"),
    ),
    computer,
  };
}

export function mergeThreadSnapshot(
  prev: ThreadSnapshot | null,
  next: ThreadSnapshot,
  preserveLoadedHistory?: boolean,
): ThreadSnapshot;
export function mergeThreadSnapshot(
  prev: ClientThreadSnapshot | null,
  next: ClientThreadSnapshot,
  preserveLoadedHistory?: boolean,
): ClientThreadSnapshot;
export function mergeThreadSnapshot(
  prev: ClientThreadSnapshot | null,
  next: ClientThreadSnapshot,
  preserveLoadedHistory = false,
): ClientThreadSnapshot {
  // A threads.get started before SSE caught up must not wipe newer live state
  // (e.g. ask cards applied after send's post-refresh request was already in flight).
  if (prev && prev.threadId === next.threadId && (prev.cursor ?? -1) > (next.cursor ?? -1))
    return prev;
  return mergeThreadHistory(prev, next, preserveLoadedHistory);
}

/**
 * Apply a threads.get refresh without clobbering newer event-sourced takeover state.
 *
 * A refresh that started earlier can still return running+busyBotName after the client
 * already applied waiting_takeover. That stale snapshot shares the cursor already applied.
 * A newer cursor is the release (or a later run) and replaces the waiting status.
 * Cursor comparisons only apply within the same thread.
 * Stop clears run/busy optimistically in the shell so an in-flight refresh cannot revive
 * the run before its run.cancelled event lands; an older-cursor refresh must keep that
 * cleared local state (see Shell stopRun).
 */
export function reconcileRefreshedThread(
  prev: ThreadSnapshot | null,
  snap: ThreadSnapshot,
  prevComputer: ComputerStatus | null,
  preserveLoadedHistory?: boolean,
): { snapshot: ThreadSnapshot; computer: ComputerStatus | null };
export function reconcileRefreshedThread(
  prev: ClientThreadSnapshot | null,
  snap: ClientThreadSnapshot,
  prevComputer: ClientThreadComputer | null,
  preserveLoadedHistory?: boolean,
): { snapshot: ClientThreadSnapshot; computer: ClientThreadComputer | null };
export function reconcileRefreshedThread(
  prev: ClientThreadSnapshot | null,
  snap: ClientThreadSnapshot,
  prevComputer: ClientThreadComputer | null,
  preserveLoadedHistory = false,
): { snapshot: ClientThreadSnapshot; computer: ClientThreadComputer | null } {
  const sameThread = Boolean(prev && prev.threadId === snap.threadId);

  if (sameThread && prev && (snap.cursor ?? -1) < (prev.cursor ?? -1)) {
    // A subscription can advance the cursor with progress before the send-triggered refresh
    // returns the new run record. Hydrate that matching run without rolling the transcript back.
    // Optimistic stop removes the matching progress message, so an older refresh cannot revive it.
    const refreshedRun = snap.run;
    const hasMatchingLiveProgress = Boolean(
      refreshedRun &&
        prev.messages.some(
          (message) =>
            message.runId === refreshedRun.id && message.id === `progress:${refreshedRun.id}`,
        ),
    );
    if (!prev.run && refreshedRun && hasMatchingLiveProgress) {
      return {
        snapshot: {
          ...prev,
          run: refreshedRun,
          activeRuns: snap.activeRuns,
          computer: snap.computer,
        },
        computer: snap.computer ?? null,
      };
    }
    // Progress can advance the thread cursor while embedded computer status from threads.get
    // is still useful — but only while a live run remains. Preserve event-sourced
    // waiting_takeover clears and optimistic stop clears.
    const preserveLocalComputer =
      prev.run?.status === "waiting_takeover" ||
      prev.activeRuns?.some((run) => run.status === "waiting_takeover") ||
      !prev.run ||
      !isActive(prev.run.status as RunStatus);
    const computer = preserveLocalComputer ? prevComputer : (snap.computer ?? null);
    return {
      snapshot:
        prev.computer === (computer ?? undefined)
          ? prev
          : { ...prev, computer: computer ?? undefined },
      computer,
    };
  }

  let snapshot = mergeThreadSnapshot(prev, snap, preserveLoadedHistory);
  let computer = snap.computer ?? null;

  if (sameThread && prev && prev.cursor === snapshot.cursor) {
    const waiting = new Set(
      [...(prev.activeRuns ?? []), ...(prev.run ? [prev.run] : [])]
        .filter((run) => run.status === "waiting_takeover")
        .map((run) => run.id),
    );
    const preserveWaiting = (run: ClientThreadRun) =>
      waiting.has(run.id) && run.status !== "waiting_takeover" && isActive(run.status as RunStatus)
        ? { ...run, status: "waiting_takeover" }
        : run;
    const run = snapshot.run ? preserveWaiting(snapshot.run) : null;
    const activeRuns = snapshot.activeRuns?.map(preserveWaiting);
    if (
      run !== snapshot.run ||
      activeRuns?.some((run, index) => run !== snapshot.activeRuns?.[index])
    ) {
      snapshot = { ...snapshot, run, activeRuns };
    }
  }
  if (
    (snapshot.run?.status === "waiting_takeover" ||
      snapshot.activeRuns?.some((run) => run.status === "waiting_takeover")) &&
    computer?.busyBotName
  )
    computer = { ...computer, busyBotName: null };

  if (snapshot.computer !== (computer ?? undefined))
    snapshot = { ...snapshot, computer: computer ?? undefined };
  return { snapshot, computer };
}

export function isThreadSnapshotEvent(event: ClientThreadEvent): boolean {
  return (
    event.type === "thread.cleared" ||
    event.type === "thread.progress" ||
    event.type === "thread.subagent" ||
    event.type === "thread.cloud_agent" ||
    event.type === "agent.tool.called" ||
    event.type === "agent.tool.completed" ||
    event.type === "thread.message.created" ||
    event.type === "thread.message.updated" ||
    event.type === "thread.message.reaction" ||
    event.type === "run.started" ||
    event.type === "run.waiting_input" ||
    event.type === "computer.takeover.requested" ||
    event.type === "computer.takeover.released" ||
    isRunTerminalEvent(event)
  );
}

export function reduceThreadSnapshot(
  prev: ThreadSnapshot | null,
  event: ProductEvent,
): ThreadSnapshot | null;
export function reduceThreadSnapshot(
  prev: ClientThreadSnapshot | null,
  event: ClientThreadEvent,
): ClientThreadSnapshot | null;
export function reduceThreadSnapshot(
  prev: ClientThreadSnapshot | null,
  event: ClientThreadEvent,
): ClientThreadSnapshot | null {
  if (!prev || event.type === "heartbeat") return prev;
  if (event.threadId && event.threadId !== prev.threadId) return prev;
  if (typeof event.seq === "number" && event.seq <= (prev.cursor ?? -1)) return prev;
  if (stopsRunHelpers(event)) {
    const messages = settleRunSubagents(prev.messages, event.runId);
    if (messages !== prev.messages) prev = { ...prev, messages };
  }

  if (event.type === "thread.cleared") {
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: [],
      olderCursor: null,
      run: null,
      activeRuns: [],
    };
  }
  if (event.type === "run.started") {
    // Background runs (ticket work) stay invisible in the transcript; the server
    // already filters their events and snapshots, this guards a late arrival.
    if (isBackgroundRunTrigger(event.payload?.trigger as string | undefined)) {
      return (event.seq ?? prev.cursor) === prev.cursor
        ? prev
        : { ...prev, cursor: event.seq ?? prev.cursor };
    }
    if (!event.runId) {
      const members = updateMemberStatus(prev.members, event.botId, "running");
      const cursor = event.seq ?? prev.cursor;
      return members === prev.members && cursor === prev.cursor
        ? prev
        : { ...prev, cursor, members };
    }
    const previousRun =
      prev.activeRuns?.find((candidate) => candidate.id === event.runId) ??
      (prev.run?.id === event.runId ? prev.run : undefined);
    const run = runFromStartedEvent(event, previousRun, prev);
    if (!run.userId && prev.run?.id === run.id) run.userId = prev.run.userId;
    const without = (prev.activeRuns ?? (prev.run ? [prev.run] : [])).filter(
      (candidate) => candidate.id !== run.id,
    );
    // Paused cards remain answerable when new work starts in any thread.
    const activeRuns = [...without.filter((r) => isActive(r.status as RunStatus)), run];
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      members: updateMemberStatus(prev.members, event.botId, "running"),
      // A group failure lives only in run; keep it until dismiss so a late member start
      // cannot wipe the banner (activeRuns still tracks the new work).
      run: prev.groupId && prev.run?.status === "failed" && prev.run.id !== run.id ? prev.run : run,
      activeRuns,
    };
  }
  if (event.type === "run.waiting_input" || event.type === "computer.takeover.requested") {
    const status = event.type === "run.waiting_input" ? "waiting_input" : "waiting_takeover";
    const runId = event.runId;
    const userId =
      event.type === "run.waiting_input" &&
      typeof event.payload?.userId === "string" &&
      event.payload?.userId.length > 0
        ? event.payload?.userId
        : undefined;
    const knownInRun = Boolean(runId && prev.run?.id === runId);
    const knownInActive = Boolean(
      runId && prev.activeRuns?.some((candidate) => candidate.id === runId),
    );
    // Peer bot_message runs are omitted from snapshots while busy; the first wait
    // event is how an open thread learns they need ask/takeover UI.
    const needsInsert = Boolean(runId) && !knownInRun && !knownInActive;
    const runChanged = Boolean(
      knownInRun &&
        prev.run &&
        (prev.run.status !== status || (userId && prev.run.userId !== userId)),
    );
    const activeRunChanged = Boolean(
      knownInActive &&
        prev.activeRuns?.some(
          (candidate) =>
            candidate.id === runId &&
            (candidate.status !== status || (userId && candidate.userId !== userId)),
        ),
    );
    const members = updateMemberStatus(prev.members, event.botId, status);
    const computer =
      event.type === "computer.takeover.requested" && prev.computer?.busyBotName
        ? { ...prev.computer, busyBotName: null }
        : prev.computer;
    // Ask pauses delete progress events server-side; drop the live bubble so a missed
    // message.created cannot leave "working…" stuck next to waiting_input.
    const liveId = progressMessageId(event);
    const messages = prev.messages.some((message) => message.id === liveId)
      ? prev.messages.filter((message) => message.id !== liveId)
      : prev.messages;
    if (
      !runChanged &&
      !activeRunChanged &&
      !needsInsert &&
      members === prev.members &&
      messages === prev.messages &&
      computer === prev.computer
    ) {
      return (event.seq ?? prev.cursor) === prev.cursor
        ? prev
        : { ...prev, cursor: event.seq ?? prev.cursor };
    }
    if (needsInsert && runId) {
      const waitingRun: ClientThreadRun = {
        id: runId,
        botId: event.botId,
        threadId: event.threadId ?? prev.threadId,
        taskId: runId,
        ...(userId ? { userId } : {}),
        status,
        trigger: "bot_message",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: event.createdAt,
        completedAt: null,
        createdAt: event.createdAt,
      };
      const baseActive = prev.activeRuns ?? (prev.run ? [prev.run] : []);
      const activeRuns = [...baseActive.filter((candidate) => candidate.id !== runId), waitingRun];
      const promoteWaiting =
        !prev.run ||
        (prev.run.status !== "waiting_input" && prev.run.status !== "waiting_takeover");
      return {
        ...prev,
        cursor: event.seq ?? prev.cursor,
        members,
        messages,
        computer,
        run: promoteWaiting ? waitingRun : prev.run,
        activeRuns,
      };
    }
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      members,
      messages,
      computer,
      run:
        runChanged && prev.run ? { ...prev.run, status, ...(userId ? { userId } : {}) } : prev.run,
      activeRuns: activeRunChanged
        ? prev.activeRuns?.map((candidate) =>
            candidate.id === runId
              ? { ...candidate, status, ...(userId ? { userId } : {}) }
              : candidate,
          )
        : prev.activeRuns,
    };
  }
  if (event.type === "computer.takeover.released") {
    const runId = event.runId;
    const settle = <T extends { id: string; status: string }>(candidate: T): T =>
      runId && candidate.id === runId && candidate.status === "waiting_takeover"
        ? { ...candidate, status: "queued" }
        : candidate;
    const nextRun = prev.run ? settle(prev.run) : prev.run;
    const activeChanged = Boolean(
      runId &&
        prev.activeRuns?.some(
          (candidate) => candidate.id === runId && candidate.status === "waiting_takeover",
        ),
    );
    const nextActive = activeChanged ? prev.activeRuns?.map(settle) : prev.activeRuns;
    const releasedWaiting = nextRun !== prev.run || activeChanged;
    const members =
      releasedWaiting &&
      prev.members?.some(
        (member) => member.botId === event.botId && member.status === "waiting_takeover",
      )
        ? updateMemberStatus(prev.members, event.botId, "queued")
        : prev.members;
    if (!releasedWaiting && members === prev.members) {
      return prev.cursor === event.seq ? prev : { ...prev, cursor: event.seq };
    }
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      members,
      run: nextRun,
      activeRuns: nextActive,
    };
  }
  if (isRunTerminalEvent(event)) {
    const activeRuns = prev.activeRuns?.filter((candidate) => candidate.id !== event.runId);
    const nextMemberRun = activeRuns?.find((candidate) => candidate.botId === event.botId);
    const failure = runFailureError(event);
    const primaryEnded = prev.run?.id === event.runId ? prev.run : null;
    // In a group the failing run may be a member run rather than the displayed one, so look
    // it up in activeRuns as well or its error would be dropped with it.
    const endedRun =
      primaryEnded ?? prev.activeRuns?.find((candidate) => candidate.id === event.runId) ?? null;
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: prev.messages.filter((message) => message.id !== progressMessageId(event)),
      members: updateMemberStatus(prev.members, event.botId, nextMemberRun?.status ?? "idle"),
      // A failed run stays in run (activeRuns already excludes it) so the transcript can say
      // why it stopped, matching what threads.get returns on the next load.
      run:
        endedRun && failure
          ? { ...endedRun, status: "failed", error: failure }
          : primaryEnded
            ? (activeRuns?.[0] ?? null)
            : prev.run,
      activeRuns,
    };
  }
  if (event.type === "thread.progress") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "progress",
      payload: event.payload,
    });
    const streaming: ClientThreadMessage = {
      id: liveId,
      threadId: event.threadId ?? prev.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return { ...prev, cursor: event.seq ?? prev.cursor, messages: [...remaining, streaming] };
  }
  if (event.type === "agent.tool.called") {
    const liveId = progressMessageId(event);
    const { previous, remaining } = takeLiveMessage(prev.messages, liveId);
    const blocks = reduceLiveMessageBlocks(previous?.blocks ?? [], {
      type: "tool",
      name: String(event.payload?.name ?? ""),
    });
    const next: ClientThreadMessage = {
      id: liveId,
      threadId: event.threadId ?? prev.threadId,
      seq: event.seq,
      role: "bot",
      blocks,
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    return { ...prev, cursor: event.seq ?? prev.cursor, messages: [...remaining, next] };
  }
  if (event.type === "agent.tool.completed") {
    return (event.seq ?? prev.cursor) === prev.cursor
      ? prev
      : { ...prev, cursor: event.seq ?? prev.cursor };
  }
  if (event.type === "thread.subagent") {
    const block = subagentBlockFromPayload(event.payload ?? {});
    const next: ClientThreadMessage = {
      id: `subagent:${block.agentId}`,
      threadId: event.threadId ?? prev.threadId,
      seq: event.seq,
      role: "bot",
      blocks: [block],
      botId: event.botId,
      runId: event.runId,
      createdAt: event.createdAt,
    };
    const without: ClientThreadMessage[] = [];
    const kept: ClientThreadMessage[] = [];
    for (const message of prev.messages) {
      if (message.id === next.id) continue;
      if (message.id.startsWith("progress:")) {
        if (message.runId) kept.push(message);
      } else {
        without.push(message);
      }
    }
    return { ...prev, cursor: event.seq ?? prev.cursor, messages: [...without, next, ...kept] };
  }

  if (event.type === "thread.cloud_agent") {
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: updateCloudAgentMessages(prev.messages, event.payload ?? {}),
    };
  }
  if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
    const role = (event.payload?.role as ClientThreadMessage["role"]) ?? "bot";
    const blocks = (event.payload?.blocks as ClientThreadMessage["blocks"]) ?? [];
    const id = String(event.payload?.messageId ?? event.id ?? `msg:${event.seq ?? 0}`);
    const known = prev.messages.find((message) => message.id === id);
    const next: ClientThreadMessage = {
      id,
      threadId: event.threadId ?? prev.threadId,
      seq: typeof event.payload?.seq === "number" ? event.payload.seq : known?.seq,
      role,
      blocks,
      botId: event.botId,
      runId: event.runId,
      callId: typeof event.payload?.callId === "string" ? event.payload?.callId : known?.callId,
      ...replyMetadata(event.payload ?? {}, known),
      createdAt: known?.createdAt ?? event.createdAt,
    };
    const replacedSubagentIds = new Set(
      blocks.filter((block) => block.kind === "subagent").map((block) => block.agentId),
    );
    const liveId = progressMessageId(event);
    const { remaining } = takeLiveMessage(prev.messages, liveId);
    const without = remaining.filter((message) => !replacedSubagent(message, replacedSubagentIds));
    return {
      ...prev,
      cursor: event.seq ?? prev.cursor,
      messages: upsertMessageById(without, next),
    };
  }
  return prev;
}

function updateMemberStatus(
  members: ClientThreadSnapshot["members"],
  botId: string | undefined,
  status: string,
): ClientThreadSnapshot["members"] {
  const member = members?.find((candidate) => candidate.botId === botId);
  if (!member || member.status === status) return members;
  return members?.map((candidate) =>
    candidate.botId === botId ? { ...candidate, status } : candidate,
  );
}

function replacedSubagent(message: ClientThreadMessage, agentIds: ReadonlySet<string>) {
  if (agentIds.size === 0) return false;
  return message.blocks.some((block) => block.kind === "subagent" && agentIds.has(block.agentId));
}

/** Retain terminal IDs while a send acknowledgement can still be in flight. */
export function rememberTerminalThreadRun(terminalRunIds: Set<string>, event: ClientThreadEvent) {
  if (!event.runId || !isRunTerminalEvent(event)) return;
  terminalRunIds.add(event.runId);
  if (terminalRunIds.size > 100) {
    const oldest = terminalRunIds.values().next().value;
    if (oldest !== undefined) terminalRunIds.delete(oldest);
  }
}
