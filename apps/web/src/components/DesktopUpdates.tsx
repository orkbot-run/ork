// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited update controls are preserved. Manual check feedback is an Ork addition.

import { Trans, useLingui } from "@lingui/react/macro";
import type { DesktopUpdateState } from "@orkbot/contracts";
import { Button, OptionSelect, toast } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { UpdateProgress } from "./UpdateProgress";

function useDesktopUpdates() {
  const { t } = useLingui();
  const bridge = desktopBridge()?.update;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [operation, setOperation] = useState<"check" | "install" | "channel" | null>(null);
  const [confirmedCheck, setConfirmedCheck] = useState<string | null>(null);
  const [manualCheckRequested, setManualCheckRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<"check" | "install" | "channel" | null>(null);
  const revision = useRef(0);
  const pollRevision = useRef(0);
  const previousCheckedAt = useRef<string | null>(null);
  const busy = operation !== null;

  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const started = revision.current;
      try {
        const next = await bridge!.state();
        if (
          !stopped &&
          started === revision.current &&
          (!pending.current || pending.current === "check")
        ) {
          if (
            pending.current === "check" &&
            (next.phase === "available" ||
              next.phase === "downloading" ||
              next.phase === "ready" ||
              (next.checkedAt !== null && next.checkedAt !== previousCheckedAt.current))
          ) {
            pollRevision.current++;
          }
          setState((current) =>
            current &&
            Object.entries(next).every(
              ([key, value]) => current[key as keyof DesktopUpdateState] === value,
            )
              ? current
              : next,
          );
        }
      } catch {
        // A disappearing bridge during shutdown should not interrupt the app.
      } finally {
        if (!stopped) timer = setTimeout(refresh, 2_000);
      }
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge]);

  useEffect(() => {
    if (!manualCheckRequested || busy || !state || state.phase === "checking") return;
    setManualCheckRequested(false);
    if (!error && state.phase === "idle" && !state.message && state.checkedAt) {
      setConfirmedCheck(state.checkedAt);
    }
  }, [manualCheckRequested, busy, state, error]);

  async function act(action: "check" | "install") {
    if (!bridge || pending.current) return;
    pending.current = action;
    revision.current++;
    const startedPoll = pollRevision.current;
    previousCheckedAt.current = state?.checkedAt ?? null;
    setOperation(action);
    setError(null);
    if (action === "check") {
      setConfirmedCheck(null);
      setManualCheckRequested(true);
    }
    try {
      const next = await bridge[action]();
      if (action !== "check" || startedPoll === pollRevision.current) {
        setState(next);
        if (next.phase === "error" || action === "install") setError(next.message);
      }
    } catch {
      if (action !== "check" || startedPoll === pollRevision.current)
        setError(t`Could not complete the update. Try again.`);
    } finally {
      revision.current++;
      pending.current = null;
      setOperation(null);
    }
  }
  async function setChannel(channel: "stable" | "beta") {
    if (!bridge?.setChannel || pending.current) return;
    pending.current = "channel";
    revision.current++;
    setOperation("channel");
    setError(null);
    setConfirmedCheck(null);
    try {
      setState(await bridge.setChannel(channel));
    } catch {
      setError(t`Could not complete the update. Try again.`);
    } finally {
      revision.current++;
      pending.current = null;
      setOperation(null);
    }
  }
  return { state, busy, operation, error, act, confirmedCheck, setChannel };
}

function useUpdateProgress(
  state: DesktopUpdateState | null,
  operation: "check" | "install" | "channel" | null,
) {
  const { t } = useLingui();
  if (!state) return null;
  if (operation === "install") return { label: t`Installing update…`, percent: null };
  if (state.phase === "downloading")
    return { label: t`Downloading update…`, percent: state.percent };
  if (state.phase === "available") return { label: t`Preparing update…`, percent: null };
  if (state.phase === "checking" || operation === "check")
    return { label: t`Checking for updates…`, percent: null };
  return null;
}

const UpdatesContext = createContext<ReturnType<typeof useDesktopUpdates> | null>(null);

const DESKTOP_UPDATE_TOAST = "desktop-update";

export function DesktopUpdatesProvider({ children }: { children: ReactNode }) {
  const updates = useDesktopUpdates();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { state, error } = updates;
  useEffect(() => {
    if (error) setDismissed(null);
  }, [error]);
  const prompt = Boolean(
    state &&
      (state.phase === "ready" || (error && state.availableVersion)) &&
      dismissed !== state.availableVersion,
  );
  // Keep the toast up while a retry runs, so a quick failure reuses it instead of racing
  // its dismissal.
  const [shown, setShown] = useState(false);
  const visible = prompt || (shown && updates.busy);
  useEffect(() => {
    setShown(visible);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    // The app's Toaster renders inside this provider, so the toast reads live state from context.
    toast.custom(() => <DesktopUpdatePrompt onLater={setDismissed} />, {
      id: DESKTOP_UPDATE_TOAST,
      duration: Number.POSITIVE_INFINITY,
      dismissible: false,
    });
    return () => {
      toast.dismiss(DESKTOP_UPDATE_TOAST);
    };
  }, [visible]);
  return <UpdatesContext.Provider value={updates}>{children}</UpdatesContext.Provider>;
}

function DesktopUpdatePrompt({ onLater }: { onLater: (version: string | null) => void }) {
  const { t } = useLingui();
  const updates = useContext(UpdatesContext);
  const activeProgress = useUpdateProgress(updates?.state ?? null, updates?.operation ?? null);
  if (!updates?.state) return null;
  const { state, busy, error, act } = updates;
  const progress = error && !busy ? null : activeProgress;
  return (
    <aside
      aria-label={t`Desktop update`}
      className="w-full rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => void act(state.phase === "ready" ? "install" : "check")}
        >
          {state.phase === "ready" ? (
            <Trans>Restart to update</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onLater(state.availableVersion)}>
          <Trans>Later</Trans>
        </Button>
      </div>
      {progress ? <UpdateProgress {...progress} /> : null}
      {!progress && (error || state.message) ? (
        <p role="status" className="mt-2 text-sm">
          {error ?? state.message}
        </p>
      ) : null}
    </aside>
  );
}

export function useSidebarUpdate() {
  const updates = useContext(UpdatesContext);
  return {
    available: updates?.state?.phase === "ready",
    busy: updates?.busy ?? false,
    install: () => {
      void updates?.act("install");
    },
  };
}

export function DesktopUpdateSection() {
  const { t } = useLingui();
  const updates = useContext(UpdatesContext);
  const activeProgress = useUpdateProgress(updates?.state ?? null, updates?.operation ?? null);
  if (!updates?.state) return null;
  const { state, busy, error, act, confirmedCheck, setChannel } = updates;
  const ready = state.phase === "ready";
  const downloading = state.phase === "available" || state.phase === "downloading";
  const checking = state.phase === "checking" && !error;
  const progress = error && !busy ? null : activeProgress;
  const notice =
    error ??
    state.message ??
    (state.phase === "idle" && confirmedCheck && state.checkedAt === confirmedCheck ? (
      <Trans>Up to date</Trans>
    ) : null);
  return (
    <section
      data-testid="desktop-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-heading3 font-medium text-foreground">
        <Trans>Desktop app</Trans>
      </h3>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">v{state.currentVersion}</span>
        <Button
          variant="outline"
          disabled={busy || downloading || checking}
          onClick={() => void act(ready ? "install" : "check")}
        >
          {ready ? (
            <Trans>Restart to update</Trans>
          ) : downloading ? (
            <Trans>Downloading…</Trans>
          ) : busy || checking ? (
            <Trans>Checking…</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
      </div>
      {state.betaAvailable ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            <Trans>Update channel</Trans>
          </span>
          <OptionSelect
            aria-label={t`Update channel`}
            className="w-auto min-w-28"
            value={state.channel ?? "stable"}
            options={[
              { value: "stable", label: t`Stable` },
              { value: "beta", label: t`Beta` },
            ]}
            disabled={busy}
            onValueChange={(channel) => void setChannel(channel)}
          />
        </div>
      ) : null}
      {progress ? <UpdateProgress {...progress} /> : null}
      {notice && !progress ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
