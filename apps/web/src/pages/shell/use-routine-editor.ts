import { useLingui } from "@lingui/react/macro";
import type { Bot, Routine, ThinkingLevel, ThreadSnapshot } from "@orkbot/contracts";
import { routineTriggerIssue } from "@orkbot/contracts";
import { cronFromPreset } from "@orkbot/core";
import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { localTimezone } from "../../lib/local-timezone";
import { parseModelOptionKey } from "../../lib/model-catalog";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { sharedInflight } from "../../lib/shared-inflight";
import { errorText } from "../../lib/user-error";
import type { RoutineDraftState, RoutineEditor } from "../RoutineEditor";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  routineNeedsOneShotArm,
  watchFromDraft,
} from "../RoutineEditor";

export function useRoutineEditor({
  rpc,
  serverOrigin,
  active,
  activeBotId,
  timezone,
  setBots,
  refreshThread,
  setPanel,
  messageProviders,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  serverOrigin?: string;
  active: Bot | undefined;
  activeBotId: RefObject<string | undefined>;
  timezone: string | null | undefined;
  messageProviders: string[];
  setBots: Dispatch<SetStateAction<Bot[]>>;
  refreshThread: (botId: string) => Promise<ThreadSnapshot>;
  setPanel: (panel: Panel) => void;
}) {
  const { t } = useLingui();
  const [routineDraft, setRoutineDraft] = useState<RoutineDraftState>(emptyRoutineDraft());
  const [revealedWebhookSecrets, setRevealedWebhookSecrets] = useState<Record<string, string>>({});
  const routineWebhookSecret = (active && revealedWebhookSecrets[active.id]) || null;
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [deleteRoutineTarget, setDeleteRoutineTarget] = useState<Routine | null>(null);
  const [savingRoutine, setSavingRoutine] = useState(false);
  const [runningRoutine, setRunningRoutine] = useState(false);
  const [routineError, setRoutineError] = useState<string | null>(null);
  const routineSavePending = useRef(false);
  const webhookSession = useRef(0);
  const webhookActionPending = useRef(new Set<string>());
  const [webhookBusyBot, setWebhookBusyBot] = useState<string | null>(null);
  useEffect(() => {
    if (!Object.keys(revealedWebhookSecrets).length) return;
    const timer = setTimeout(() => setRevealedWebhookSecrets({}), 60_000);
    return () => clearTimeout(timer);
  }, [revealedWebhookSecrets]);
  const webhookSecretProvisionRef = useRef(new Map<string, Promise<string>>());
  const ensureWebhookSecret = (botId: string, onlyIfMissing: boolean) =>
    sharedInflight(webhookSecretProvisionRef.current, botId, async () => {
      const session = webhookSession.current;
      const result = await rpc.bots.rotateWebhookSecret({
        botId,
        ...(onlyIfMissing ? { onlyIfMissing: true } : {}),
      });
      if (session === webhookSession.current) {
        setRevealedWebhookSecrets((current) => ({ ...current, [botId]: result.secret }));
      }
      setBots((current) =>
        current.map((bot) => (bot.id === botId ? { ...bot, webhookConfigured: true } : bot)),
      );
      return result.secret;
    });
  const routineSaveRequest = useRef(0);
  const routineRunPending = useRef(false);
  const publicPath = (path: string) => (serverOrigin ? new URL(path, serverOrigin).href : path);
  const addSkillRoutine = useCallback((name: string, prompt: string) => {
    setRoutineDraft({ ...emptyRoutineDraft(), name, prompt });
    webhookSession.current += 1;
    setRevealedWebhookSecrets({});
    setEditingRoutine(null);
    setPanel("routine");
  }, []);

  function restoreRoutine(routine: Routine | null) {
    setEditingRoutine(routine);
    setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
    webhookSession.current += 1;
    setRevealedWebhookSecrets({});
  }
  function editRoutine(routine: Routine) {
    setRoutineDraft(draftFromRoutine(routine));
    webhookSession.current += 1;
    setRevealedWebhookSecrets({});
    setEditingRoutine(routine);
  }
  function startRoutine(routine?: Routine) {
    setRoutineDraft(routine ? draftFromRoutine(routine) : emptyRoutineDraft());
    webhookSession.current += 1;
    setRevealedWebhookSecrets({});
    setEditingRoutine(routine ?? null);
    setRoutineError(null);
    setPanel("routine");
  }
  function resetRoutineTarget() {
    setEditingRoutine(null);
    setDeleteRoutineTarget(null);
  }
  function leaveRoutine() {
    webhookSession.current += 1;
    setRevealedWebhookSecrets({});
    routineSaveRequest.current += 1;
    setRoutineError(null);
  }
  const editorProps = active
    ? ({
        draft: routineDraft,
        onChange: setRoutineDraft,
        editing: editingRoutine,
        timezone: editingRoutine?.timezone ?? timezone ?? localTimezone(),
        webhook: {
          path: publicPath(`/api/v1/bots/${encodeURIComponent(active.id)}/webhook`),
          secret: routineWebhookSecret,
          configured: active.webhookConfigured || Boolean(routineWebhookSecret),
          busy: webhookBusyBot === active.id,
        },
        githubPath: publicPath(`/api/v1/bots/${encodeURIComponent(active.id)}/github`),
        messageProviders,
        saving: savingRoutine,
        running: runningRoutine,
        error: routineError,
        onBack: () => setPanel("routines"),
        onClose: () => setPanel(null),
        onEnsureWebhook: async () => {
          if (webhookActionPending.current.has(active.id)) return;
          webhookActionPending.current.add(active.id);
          setWebhookBusyBot(active.id);
          try {
            await ensureWebhookSecret(
              active.id,
              !(active.webhookConfigured || routineWebhookSecret),
            );
          } catch (error) {
            if (activeBotId.current === active.id)
              setRoutineError(errorText(error, t`Could not load webhook key`));
          } finally {
            webhookActionPending.current.delete(active.id);
            setWebhookBusyBot((current) => (current === active.id ? null : current));
          }
        },
        onRevealWebhook: async () => {
          const botId = active.id;
          const session = webhookSession.current;
          if (webhookActionPending.current.has(botId)) return;
          webhookActionPending.current.add(botId);
          setWebhookBusyBot(botId);
          try {
            const result = await rpc.bots.getWebhookConfig({ botId });
            if (session !== webhookSession.current || activeBotId.current !== botId) return;
            if (!result) throw new Error(t`No webhook key configured`);
            setRevealedWebhookSecrets((current) => ({ ...current, [botId]: result.secret }));
          } catch (error) {
            if (session === webhookSession.current && activeBotId.current === botId) {
              setRoutineError(errorText(error, t`Could not load webhook key`));
            }
          } finally {
            webhookActionPending.current.delete(botId);
            setWebhookBusyBot((current) => (current === botId ? null : current));
          }
        },
        onSave: async () => {
          if (routineSavePending.current) return;
          const targetBotId = active.id;
          const targetRoutine = editingRoutine;
          if (targetRoutine && targetRoutine.botId !== targetBotId) return;
          const watchResult = routineDraft.watch ? watchFromDraft(routineDraft.watch) : null;
          if (watchResult && "error" in watchResult) {
            setRoutineError(watchResult.error);
            return;
          }
          const watch = watchResult?.watch ?? null;
          const crons = routineDraft.schedules.map(cronFromPreset);
          const triggerIssue = routineTriggerIssue({ ...routineDraft, crons, watch });
          if (triggerIssue) {
            setRoutineError(triggerIssue.message);
            return;
          }
          const saveRequest = ++routineSaveRequest.current;
          routineSavePending.current = true;
          setSavingRoutine(true);
          setRoutineError(null);
          try {
            if (
              (routineDraft.webhookEnabled || routineDraft.githubEnabled) &&
              !active.webhookConfigured &&
              !routineWebhookSecret
            ) {
              await ensureWebhookSecret(targetBotId, true);
            }
            const model = routineDraft.modelKey ? parseModelOptionKey(routineDraft.modelKey) : null;
            const routineModel = {
              modelProvider: model?.provider ?? null,
              modelId: model?.modelId ?? null,
              thinkingLevel: (model && routineDraft.thinkingLevel
                ? routineDraft.thinkingLevel
                : null) as ThinkingLevel | null,
            };
            let saved: Routine;
            if (targetRoutine) {
              const armOneShot = routineNeedsOneShotArm(targetRoutine, crons);
              let runAt: string | undefined;
              if (armOneShot) {
                if (!routineDraft.runAtLocal) {
                  setRoutineError(t`Add a run time for this one-shot.`);
                  return;
                }
                const parsed = new Date(routineDraft.runAtLocal);
                if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
                  setRoutineError(t`Run time must be in the future.`);
                  return;
                }
                runAt = parsed.toISOString();
              }
              saved = await rpc.routines.update({
                routineId: targetRoutine.id,
                name: routineDraft.name || t`Routine`,
                prompt: routineDraft.prompt || t`Check in.`,
                crons,
                // Send on/off only when this save changes it, so a stale draft cannot undo a
                // disable made elsewhere since the editor opened.
                ...(armOneShot || routineDraft.active !== targetRoutine.active
                  ? { active: armOneShot ? true : routineDraft.active }
                  : {}),
                webhookEnabled: routineDraft.webhookEnabled,
                githubEnabled: routineDraft.githubEnabled,
                messageProvider: routineDraft.messageProvider,
                watch,
                ...(routineModel.modelProvider !== targetRoutine.modelProvider ||
                routineModel.modelId !== targetRoutine.modelId ||
                routineModel.thinkingLevel !== targetRoutine.thinkingLevel
                  ? routineModel
                  : {}),
                ...(runAt ? { runAt } : {}),
              });
            } else {
              saved = await rpc.routines.create({
                botId: targetBotId,
                name: routineDraft.name || t`Routine`,
                prompt: routineDraft.prompt || t`Check in.`,
                crons,
                timezone: timezone ?? localTimezone(),
                active: routineDraft.active,
                notify: true,
                webhookEnabled: routineDraft.webhookEnabled,
                githubEnabled: routineDraft.githubEnabled,
                messageProvider: routineDraft.messageProvider,
                watch,
                ...routineModel,
              });
            }
            if (routineSaveRequest.current === saveRequest && activeBotId.current === targetBotId) {
              setEditingRoutine(saved);
              // Fields edited while the save was in flight keep the newer value.
              const fresh = draftFromRoutine(saved);
              setRoutineDraft(
                (current) =>
                  Object.fromEntries(
                    Object.entries(fresh).map(([key, value]) => {
                      const field = key as keyof RoutineDraftState;
                      return [key, current[field] === routineDraft[field] ? value : current[field]];
                    }),
                  ) as RoutineDraftState,
              );
            }
          } catch (error) {
            if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
              return;
            }
            setRoutineError(errorText(error, t`Could not save routine`));
            return;
          } finally {
            routineSavePending.current = false;
            setSavingRoutine(false);
          }
          if (routineSaveRequest.current !== saveRequest || activeBotId.current !== targetBotId) {
            return;
          }
          await refreshThread(targetBotId).catch(() => undefined);
        },
        onTestRun: async () => {
          if (routineRunPending.current) return;
          const targetBotId = active.id;
          const targetRoutine = editingRoutine;
          if (!targetRoutine) return;
          routineRunPending.current = true;
          setRunningRoutine(true);
          setRoutineError(null);
          try {
            await rpc.routines.testRun({ routineId: targetRoutine.id });
            await refreshThread(targetBotId);
          } catch (error) {
            if (activeBotId.current === targetBotId) {
              setRoutineError(errorText(error, t`Could not run routine`));
            }
          } finally {
            routineRunPending.current = false;
            setRunningRoutine(false);
          }
        },
        onDelete: () => {
          if (editingRoutine) {
            setDeleteRoutineTarget(editingRoutine);
            return;
          }
          setPanel("routines");
        },
      } satisfies ComponentProps<typeof RoutineEditor>)
    : null;
  const deleteDialogProps = deleteRoutineTarget
    ? {
        item: deleteRoutineTarget,
        noun: "routine" as const,
        onCancel: () => setDeleteRoutineTarget(null),
        onConfirm: async () => {
          const target = deleteRoutineTarget;
          await rpc.routines.remove({ routineId: target.id });
          setDeleteRoutineTarget(null);
          setEditingRoutine((current) => (current?.id === target.id ? null : current));
          if (activeBotId.current !== target.botId) return;
          await refreshThread(target.botId);
          if (activeBotId.current === target.botId) setPanel("routines");
        },
      }
    : null;
  return {
    editorProps,
    deleteDialogProps,
    editingRoutine,
    restoreRoutine,
    editRoutine,
    startRoutine,
    resetRoutineTarget,
    leaveRoutine,
    addSkillRoutine,
  };
}
