// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans, useLingui } from "@lingui/react/macro";
import type { MeetingSummary } from "@orkbot/contracts";
import { parseMeetingLink } from "@orkbot/contracts";
import { Button, Input } from "@orkbot/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import { errorText } from "../../lib/user-error";

const active = (meeting: MeetingSummary) =>
  ["scheduled", "joining", "recording", "processing"].includes(meeting.status);
export function meetingTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function Meetings({ botId, initialUrl = "" }: { botId: string; initialUrl?: string }) {
  const { t } = useLingui();
  const statusLabels = {
    scheduled: t`Scheduled`,
    joining: t`Joining`,
    recording: t`Recording`,
    processing: t`Processing`,
    completed: t`Completed`,
    failed: t`Failed`,
    canceled: t`Canceled`,
  };
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const cache = useQueryClient();
  const id = useId();
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidUrl, setInvalidUrl] = useState(false);
  const status = useQuery(queries.meetings.status.queryOptions());
  const listOptions = queries.meetings.list.queryOptions({ input: { botId } });
  const list = useQuery({
    ...listOptions,
    enabled: status.data?.enabled === true,
    refetchInterval: (query) => (query.state.data?.some(active) ? 15_000 : false),
    refetchIntervalInBackground: false,
  });
  const detail = useQuery({
    ...queries.meetings.get.queryOptions({ input: { meetingId: selected ?? "" } }),
    enabled: Boolean(selected) && status.data?.enabled === true,
    refetchInterval: (query) => (query.state.data && active(query.state.data) ? 15_000 : false),
    refetchIntervalInBackground: false,
  });
  async function run(action: () => Promise<unknown>, refreshDetail = true) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await cache.invalidateQueries({ queryKey: listOptions.queryKey });
      if (selected && refreshDetail) await detail.refetch();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  if (status.isPending)
    return (
      <p role="status">
        <Trans>Loading…</Trans>
      </p>
    );
  if (status.isError) return <p role="alert">{errorText(status.error)}</p>;
  if (!status.data?.enabled)
    return (
      <p>
        <Trans>Meetings are not available on this server.</Trans>
      </p>
    );
  const meeting = detail.data;
  return (
    <section className="space-y-5 min-w-0" aria-label={t`Meetings`}>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {selected ? (
        <>
          <Button
            variant="outline"
            onClick={() => {
              setSelected(null);
              setDeleting(false);
              setError(null);
            }}
          >
            <Trans>Back to meetings</Trans>
          </Button>
          {detail.isPending ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : detail.isError ? (
            <p role="alert">{errorText(detail.error)}</p>
          ) : meeting ? (
            <>
              <h3 className="text-lg font-semibold break-words">{meeting.title}</h3>
              <p className="text-sm text-muted-foreground">
                {platformLabel(meeting.platform)} · {statusLabels[meeting.status]}
              </p>
              {meeting.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {meeting.error}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void detail.refetch()}>
                  <Trans>Refresh</Trans>
                </Button>
                {["scheduled", "joining", "recording"].includes(meeting.status) ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => rpc.meetings.leave({ meetingId: meeting.id }))}
                  >
                    {meeting.status === "scheduled" ? (
                      <Trans>Cancel meeting</Trans>
                    ) : (
                      <Trans>Stop and leave</Trans>
                    )}
                  </Button>
                ) : null}
                {!active(meeting) ? (
                  <Button variant="outline" disabled={busy} onClick={() => setDeleting(true)}>
                    <Trans>Delete meeting</Trans>
                  </Button>
                ) : null}
              </div>
              {deleting ? (
                <div className="rounded-xl border border-border p-4 space-y-3">
                  <p className="text-sm">
                    <Trans>Delete this meeting and its transcript? This cannot be undone.</Trans>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await rpc.meetings.remove({ meetingId: meeting.id });
                          setSelected(null);
                          setDeleting(false);
                        }, false)
                      }
                    >
                      <Trans>Confirm deletion</Trans>
                    </Button>
                    <Button variant="outline" onClick={() => setDeleting(false)}>
                      <Trans>Keep meeting</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}
              <h4 className="font-medium">
                <Trans>Transcript</Trans>
              </h4>
              {meeting.transcript.length ? (
                <ol className="space-y-4">
                  {meeting.transcript.map((segment, index) => (
                    <li key={`${segment.startMs}-${index}`} className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">{segment.speaker}</span> ·{" "}
                        {meetingTime(segment.startMs)}–{meetingTime(segment.endMs)}
                      </p>
                      <p className="text-sm whitespace-pre-wrap break-words">{segment.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <Trans>No transcript yet. It will appear after processing.</Trans>
                </p>
              )}
            </>
          ) : null}
        </>
      ) : (
        <>
          <form
            className="space-y-4"
            aria-labelledby={`${id}-heading`}
            onSubmit={(event) => {
              event.preventDefault();
              if (!parseMeetingLink(url)) {
                setInvalidUrl(true);
                document.getElementById(`${id}-url`)?.focus();
                return;
              }
              if (!confirmed) return;
              void run(async () => {
                const created = await rpc.meetings.create({
                  botId,
                  url: url.trim(),
                  title: title.trim() || undefined,
                  scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
                  confirmed: true,
                });
                setConfirmed(false);
                setUrl("");
                setTitle("");
                setScheduledAt("");
                setSelected(created.id);
              });
            }}
          >
            <h3 id={`${id}-heading`} className="font-semibold">
              <Trans>Invite your bot to a meeting</Trans>
            </h3>
            <p className="text-sm text-muted-foreground">
              <Trans>
                The bot joins visibly, records audio and creates a transcript. Inform every
                participant before inviting it.
              </Trans>
            </p>
            <div>
              <label htmlFor={`${id}-url`} className="text-sm">
                <Trans>Meeting link</Trans>
              </label>
              <Input
                id={`${id}-url`}
                name="url"
                type="url"
                required
                value={url}
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={invalidUrl || undefined}
                aria-describedby={`${id}-url-help`}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (invalidUrl && parseMeetingLink(event.target.value)) setInvalidUrl(false);
                }}
              />
              <p
                id={`${id}-url-help`}
                className={`text-xs mt-1 ${invalidUrl ? "text-destructive" : "text-muted-foreground"}`}
                role={invalidUrl ? "alert" : undefined}
              >
                {invalidUrl ? (
                  <Trans>
                    Enter a supported Google Meet, Zoom or Microsoft Teams meeting link.
                  </Trans>
                ) : (
                  <Trans>Google Meet, Zoom and Microsoft Teams links are supported.</Trans>
                )}
              </p>
            </div>
            <div>
              <label htmlFor={`${id}-title`} className="text-sm">
                <Trans>Title (optional)</Trans>
              </label>
              <Input
                id={`${id}-title`}
                name="title"
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${id}-schedule`} className="text-sm">
                <Trans>Schedule (optional)</Trans>
              </label>
              <Input
                id={`${id}-schedule`}
                name="scheduledAt"
                type="datetime-local"
                value={scheduledAt}
                min={new Date(Date.now() + 60_000)
                  .toLocaleString("sv-SE")
                  .replace(" ", "T")
                  .slice(0, 16)}
                onChange={(event) => setScheduledAt(event.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                <Trans>Leave empty to join now. Scheduled time uses your device time zone.</Trans>
              </p>
            </div>
            <div className="flex items-start gap-3">
              <input
                id={`${id}-consent`}
                name="confirmed"
                type="checkbox"
                required
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                className="mt-1 size-5 shrink-0"
              />
              <label htmlFor={`${id}-consent`} className="text-sm">
                <Trans>
                  I have informed all participants and have permission to record and transcribe this
                  meeting.
                </Trans>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              <Trans>
                Daily limit: {status.data.dailyLimit}. Maximum meeting length:{" "}
                {status.data.maxMinutes} minutes.
              </Trans>
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Trans>Saving…</Trans>
              ) : scheduledAt ? (
                <Trans>Schedule meeting</Trans>
              ) : (
                <Trans>Join meeting</Trans>
              )}
            </Button>
          </form>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">
              <Trans>Meetings</Trans>
            </h3>
            <Button
              variant="outline"
              disabled={list.isFetching}
              onClick={() => void list.refetch()}
            >
              <Trans>Refresh</Trans>
            </Button>
          </div>
          {list.isPending ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : list.isError ? (
            <p role="alert">{errorText(list.error)}</p>
          ) : list.data?.length ? (
            <ul className="divide-y divide-border">
              {list.data.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full min-h-12 text-start py-3 rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="block text-sm font-medium break-words">{item.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {platformLabel(item.platform)} · {statusLabels[item.status]} ·{" "}
                      {new Date(item.scheduledAt ?? item.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>No meetings yet.</Trans>
            </p>
          )}
        </>
      )}
    </section>
  );
}
function platformLabel(platform: string) {
  return platform === "google_meet"
    ? "Google Meet"
    : platform === "zoom"
      ? "Zoom"
      : "Microsoft Teams";
}
