// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans, useLingui } from "@lingui/react/macro";
import type { AuditEvent } from "@orkbot/contracts";
import { Button, Spinner } from "@orkbot/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";

export interface AuditLogProps {
  events: readonly AuditEvent[];
  loading: boolean;
  loadFailed: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onExport: (signal: AbortSignal) => Promise<void>;
  timezone: string | null;
}

export function AuditLog({
  events,
  loading,
  loadFailed,
  loadingMore,
  hasMore,
  onRetry,
  onLoadMore,
  onExport,
  timezone,
}: AuditLogProps) {
  const { i18n, t } = useLingui();
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const exportPending = useRef(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const formatter = useMemo(() => {
    const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "medium" };
    try {
      return new Intl.DateTimeFormat(i18n.locale || "en", {
        ...options,
        ...(timezone ? { timeZone: timezone } : {}),
      });
    } catch {
      return new Intl.DateTimeFormat(i18n.locale || "en", options);
    }
  }, [i18n.locale, timezone]);

  async function exportEvents() {
    if (exportPending.current) return;
    exportPending.current = true;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    try {
      await onExport(controller.signal);
      if (!controller.signal.aborted) setExportFailed(false);
    } catch {
      if (!controller.signal.aborted) setExportFailed(true);
    } finally {
      exportPending.current = false;
      exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }

  const actorType = (type: AuditEvent["actorType"]) =>
    type === "user" ? t`User` : type === "bot" ? t`Bot` : t`System`;
  const outcome = (value: AuditEvent["outcome"]) =>
    value === "success" ? t`Success` : value === "failure" ? t`Failure` : t`Denied`;

  return (
    <section className="@container space-y-4" data-testid="audit-log" aria-label={t`Activity log`}>
      <div className="flex justify-end">
        <Button variant="outline" disabled={exporting} onClick={() => void exportEvents()}>
          {exporting ? <Trans>Exporting…</Trans> : <Trans>Export</Trans>}
        </Button>
      </div>
      {exportFailed && (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not export activity log. Try again.</Trans>
        </p>
      )}
      {loadFailed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <p>
            <Trans>Could not load activity log</Trans>
          </p>
          <Button variant="outline" disabled={loading || loadingMore} onClick={onRetry}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          <Trans>Loading activity log…</Trans>
        </p>
      )}
      {!loading && !loadFailed && events.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <Trans>No activity yet</Trans>
        </p>
      )}
      {events.length > 0 && (
        <ol
          className="divide-y divide-border rounded-lg border border-border px-4"
          aria-label={t`Audit events`}
        >
          {events.map((event) => {
            const at = new Date(event.createdAt);
            return (
              <li key={event.id} className="py-3" data-testid="audit-event">
                <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2.5 text-[13px] @sm:grid-cols-2 @2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.75fr)_minmax(0,1fr)]">
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      <Trans>Actor</Trans>
                    </dt>
                    <dd className="text-foreground [overflow-wrap:anywhere]">
                      {event.actorLabel || event.actorId || actorType(event.actorType)}
                    </dd>
                    {(event.actorLabel || event.actorId) && (
                      <dd className="text-xs text-muted-foreground">
                        {actorType(event.actorType)}
                      </dd>
                    )}
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      <Trans>Action</Trans>
                    </dt>
                    <dd className="font-mono text-foreground [overflow-wrap:anywhere]">
                      {event.action}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-muted-foreground">
                      <Trans>Target</Trans>
                    </dt>
                    <dd className="text-foreground [overflow-wrap:anywhere]">
                      {event.targetLabel || event.targetId || event.targetType || "—"}
                    </dd>
                    {event.targetType && (event.targetLabel || event.targetId) && (
                      <dd className="break-words text-xs text-muted-foreground">
                        {event.targetType}
                      </dd>
                    )}
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">
                      <Trans>Outcome</Trans>
                    </dt>
                    <dd
                      className={
                        event.outcome === "success" ? "text-foreground" : "text-destructive"
                      }
                    >
                      {outcome(event.outcome)}
                    </dd>
                  </div>
                  <div className="min-w-0 @sm:col-span-2 @2xl:col-span-1">
                    <dt className="text-xs text-muted-foreground">
                      <Trans>Time</Trans>
                    </dt>
                    <dd className="text-foreground">
                      <time dateTime={event.createdAt}>
                        {Number.isNaN(at.getTime()) ? event.createdAt : formatter.format(at)}
                      </time>
                    </dd>
                  </div>
                  {(["connectorId", "connectionId"] as const).map(
                    (key) =>
                      event.metadata[key] != null && (
                        <div key={key} className="min-w-0 @2xl:col-span-2">
                          <dt className="text-xs text-muted-foreground">
                            {key === "connectorId" ? (
                              <Trans>Connector ID</Trans>
                            ) : (
                              <Trans>Connection ID</Trans>
                            )}
                          </dt>
                          <dd className="break-all font-mono text-xs text-foreground">
                            {String(event.metadata[key])}
                          </dd>
                        </div>
                      ),
                  )}
                </dl>
              </li>
            );
          })}
        </ol>
      )}
      {hasMore && (
        <Button variant="outline" disabled={loading || loadingMore} onClick={onLoadMore}>
          {loadingMore ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
        </Button>
      )}
    </section>
  );
}
