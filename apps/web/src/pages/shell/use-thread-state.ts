import type {
  AppBootstrap,
  Bot,
  Routine,
  TaughtSkill,
  ThreadMessage,
  ThreadSnapshot,
} from "@orkbot/contracts";
import { activeThreadRuns, isRunWorking, withLiveStreamingProgress } from "@orkbot/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SpaceQueries } from "../../lib/query";
import { queryClient } from "../../lib/query";
import {
  getResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../../lib/response-streaming";

export type PinnedAround = {
  botId?: string;
  groupId?: string;
  messageId: string;
  threadId: string;
  messages: ThreadMessage[];
  olderCursor: number | null;
};

/** What a chat may show while its live snapshot loads. */
export function cachedThreadSnapshot(
  queries: SpaceQueries,
  seed: AppBootstrap | undefined,
  target: { bot: Bot } | { groupId: string },
): ThreadSnapshot | null {
  if ("groupId" in target) {
    const { groupId } = target;
    const cached = queryClient.getQueryData(queries.threads.get.queryKey({ input: { groupId } }));
    return cached ?? (seed?.thread?.groupId === groupId ? seed.thread : null);
  }
  const { bot } = target;
  const cached = queryClient.getQueryData(
    queries.threads.get.queryKey({ input: { botId: bot.id } }),
  );
  const snapshot = cached ?? (seed?.thread?.botId === bot.id ? seed.thread : null);
  if (!snapshot || snapshot.groupId) return null;
  return bot.threadStatus === undefined ||
    activeThreadRuns(snapshot).some((run) => isRunWorking(run.status)) ===
      isRunWorking(bot.threadStatus)
    ? snapshot
    : null;
}

/** The open chat's snapshot, the bot data loaded with it, and where its loaded history stands. */
export function useThreadState(readSeed: () => ThreadSnapshot | null) {
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  const [seed] = useState(readSeed);
  const [snapshot, setSnapshot] = useState(() => withLiveStreamingProgress(seed, streamResponses));
  const snapshotRef = useRef<ThreadSnapshot | null>(seed);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const [taughtSkills, setTaughtSkills] = useState<TaughtSkill[]>([]);
  const [taughtSkillsBotId, setTaughtSkillsBotId] = useState<string | null>(null);
  const bootstrappedThread = useRef<ThreadSnapshot | null>(null);
  const expandedHistoryThread = useRef<string | null>(null);
  const historyEpoch = useRef(0);
  const messageScroll = useRef<HTMLDivElement>(null);
  const pinnedAroundRef = useRef<PinnedAround | null>(null);

  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }

  /** Drops expanded or pinned history, and any page still loading for it. */
  function resetHistory() {
    expandedHistoryThread.current = null;
    pinnedAroundRef.current = null;
    historyEpoch.current += 1;
  }

  return {
    snapshot,
    snapshotRef,
    commitSnapshot,
    updateSnapshot,
    routines,
    setRoutines,
    routinesBotId,
    setRoutinesBotId,
    taughtSkills,
    setTaughtSkills,
    taughtSkillsBotId,
    setTaughtSkillsBotId,
    bootstrappedThread,
    expandedHistoryThread,
    historyEpoch,
    messageScroll,
    pinnedAroundRef,
    resetHistory,
  };
}

export type ThreadState = ReturnType<typeof useThreadState>;
