// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { UsageBreakdown } from "@orkbot/contracts";
import { Button, NativeSelect, NativeSelectOption, Skeleton } from "@orkbot/ui-web";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orkbot/ui-web/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import "./usage-settings.css";

type Totals = UsageBreakdown["totals"];
type Metric = "runs" | "modelCalls" | "inputTokens" | "outputTokens" | "costUsd";

export function UsageSettingsPanel({ panelRef }: { panelRef?: RefObject<HTMLDivElement | null> }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [range, setRange] = useState<UsageBreakdown["range"]>("30d");
  const [botId, setBotId] = useState("");
  const [model, setModel] = useState("");
  const selectedModel: [string, string] | undefined = model ? JSON.parse(model) : undefined;
  const query = useQuery(
    queries.usage.breakdown.queryOptions({
      input: {
        range,
        ...(botId ? { botId } : {}),
        ...(selectedModel ? { provider: selectedModel[0], model: selectedModel[1] } : {}),
      },
    }),
  );
  const data = query.data;
  const id = useId();
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-testid="usage-settings"
      aria-busy={query.isFetching}
      className="min-w-0 space-y-5 outline-none"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="min-w-0 space-y-1 text-sm" htmlFor={`${id}-range`}>
          <span className="text-muted-foreground">
            <Trans>Period</Trans>
          </span>
          <NativeSelect
            id={`${id}-range`}
            data-testid="usage-range"
            className="w-full"
            value={range}
            onChange={(event) => {
              setRange(event.target.value as UsageBreakdown["range"]);
              setBotId("");
              setModel("");
            }}
          >
            <NativeSelectOption value="today">{t`Today`}</NativeSelectOption>
            <NativeSelectOption value="7d">{t`Last 7 days`}</NativeSelectOption>
            <NativeSelectOption value="30d">{t`Last 30 days`}</NativeSelectOption>
            <NativeSelectOption value="all">{t`All time`}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="min-w-0 space-y-1 text-sm" htmlFor={`${id}-bot`}>
          <span className="text-muted-foreground">
            <Trans>Bot</Trans>
          </span>
          <NativeSelect
            id={`${id}-bot`}
            data-testid="usage-bot"
            className="w-full"
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
          >
            <NativeSelectOption value="">{t`All bots`}</NativeSelectOption>
            {data?.botOptions.map((bot) => (
              <NativeSelectOption key={bot.botId} value={bot.botId}>
                {bot.name ?? (bot.deleted ? t`Deleted bot` : bot.botId)}
                {bot.deleted && bot.name ? ` (${t`Deleted`})` : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="min-w-0 space-y-1 text-sm" htmlFor={`${id}-model`}>
          <span className="text-muted-foreground">
            <Trans>Model</Trans>
          </span>
          <NativeSelect
            id={`${id}-model`}
            data-testid="usage-model"
            className="w-full"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <NativeSelectOption value="">{t`All models`}</NativeSelectOption>
            {data?.modelOptions.map((option) => {
              const value = JSON.stringify([option.provider, option.model]);
              return (
                <NativeSelectOption key={value} value={value}>
                  {option.model} · {option.provider}
                </NativeSelectOption>
              );
            })}
          </NativeSelect>
        </label>
      </div>
      {query.isError ? (
        <div
          data-testid="usage-error"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4"
        >
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {data
              ? t`Could not refresh usage. Showing the last available numbers.`
              : t`Could not load usage.`}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {query.isPending ? (
        <div
          data-testid="usage-loading"
          role="progressbar"
          aria-label={t`Loading usage`}
          className="grid grid-cols-2 gap-3 sm:grid-cols-5"
        >
          {[0, 1, 2, 3, 4].map((key) => (
            <Skeleton key={key} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : null}
      {data ? <UsageBreakdownView data={data} /> : null}
    </div>
  );
}

export function UsageBreakdownView({ data }: { data: UsageBreakdown }) {
  const { t, i18n } = useLingui();
  const id = useId();
  const count = new Intl.NumberFormat(i18n.locale);
  const usd = new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const number = (value: number | null) => (value == null ? "—" : count.format(value));
  const money = (value: number | null) =>
    value == null
      ? "—"
      : value > 0 && value < 0.0001
        ? `<${usd.format(0.0001)}`
        : usd.format(value);
  const metrics: { key: Metric; label: string }[] = [
    { key: "runs", label: t`Runs` },
    { key: "modelCalls", label: t`Calls` },
    { key: "inputTokens", label: t`Input tokens` },
    { key: "outputTokens", label: t`Output tokens` },
    { key: "costUsd", label: t`Cost (USD)` },
  ];
  const value = (row: Totals, key: Metric) =>
    key === "costUsd" ? money(row[key]) : number(row[key]);
  const date = (raw: string) =>
    new Intl.DateTimeFormat(i18n.locale, {
      timeZone: "UTC",
      month: "short",
      ...(data.overTimeUnit === "day" ? { day: "numeric" } : { year: "numeric" }),
    }).format(new Date(`${raw}T00:00:00Z`));
  const table = (
    testId: string,
    title: string,
    firstColumn: string,
    rows: { id: string; name: string; detail?: string; totals: Totals }[],
  ) => (
    <div className="space-y-2">
      <h3 id={`${id}-${testId}`} className="text-sm font-medium text-foreground">
        {title}
      </h3>
      <section
        data-testid={testId}
        aria-labelledby={`${id}-${testId}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the table region.
        tabIndex={0}
        className="usage-table-region rounded-xl border border-border focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Table className="text-[13px]">
          <caption className="sr-only">{title}</caption>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow>
              <TableHead scope="col">{firstColumn}</TableHead>
              {metrics.map((metric) => (
                <TableHead scope="col" key={metric.key} className="text-right">
                  {metric.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <th scope="row" className="sticky left-0 bg-background p-2 text-left font-normal">
                  <span className="block max-w-48 break-words text-foreground">{row.name}</span>
                  {row.detail ? (
                    <span className="text-xs text-muted-foreground">{row.detail}</span>
                  ) : null}
                </th>
                {metrics.map((metric) => (
                  <TableCell key={metric.key} className="text-right tabular-nums">
                    {value(row.totals, metric.key)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
  const maximum = Math.max(1, ...data.overTime.map((row) => row.runs));
  return (
    <>
      <dl data-testid="usage-totals" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.key} className="rounded-xl border border-border px-3 py-3">
            <dt className="text-xs text-muted-foreground">{metric.label}</dt>
            <dd
              data-testid={`usage-stat-${metric.key}`}
              className="mt-1 break-words text-xl font-medium tabular-nums text-foreground"
            >
              {value(data.totals, metric.key)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          <Trans>Timezone</Trans>: {data.timezone}
        </span>
        <span>
          <Trans>— = not reported</Trans>
        </span>
      </div>
      {data.totals.runs === 0 && data.totals.modelCalls === 0 ? (
        <p
          data-testid="usage-empty"
          className="rounded-xl border border-border p-5 text-sm text-muted-foreground"
        >
          <Trans>No usage in this period. Try another period or filter.</Trans>
        </p>
      ) : (
        <>
          <div
            data-testid="usage-timeline"
            className="space-y-3 rounded-xl border border-border p-4"
          >
            <h3 className="text-sm font-medium">
              <Trans>Runs over time</Trans>
            </h3>
            <div className="text-xs tabular-nums text-muted-foreground">{number(maximum)}</div>
            <div
              role="img"
              aria-label={t`Runs over time. Exact values are available in the timeline data table.`}
              className="flex h-32 items-end gap-1 border-b border-border"
            >
              {data.overTime.map((row) => (
                <div
                  key={row.date}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end"
                  title={`${date(row.date)}: ${number(row.runs)}`}
                >
                  <div
                    aria-hidden="true"
                    className="w-full rounded-t-sm bg-primary/60"
                    style={{ height: `${(row.runs / maximum) * 100}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">0</div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{data.overTime[0] ? date(data.overTime[0].date) : ""}</span>
              <span>{data.overTime.at(-1) ? date(data.overTime.at(-1)!.date) : ""}</span>
            </div>
            <details>
              <summary className="cursor-pointer py-1 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <Trans>Timeline data</Trans>
              </summary>
              <div className="pt-3">
                {table(
                  "usage-timeline-data",
                  t`Timeline data`,
                  t`Date`,
                  data.overTime.map((row) => ({ id: row.date, name: date(row.date), totals: row })),
                )}
              </div>
            </details>
          </div>
          {table(
            "usage-bots",
            t`By bot`,
            t`Bot`,
            data.bots.map((row) => ({
              id: row.botId ?? "unassigned",
              name: row.name ?? (row.deleted ? t`Deleted bot` : t`Unassigned`),
              detail: row.deleted && row.name ? t`Deleted` : undefined,
              totals: row,
            })),
          )}
          {table(
            "usage-models",
            t`By model`,
            t`Model`,
            data.models.map((row) => ({
              id: JSON.stringify([row.provider, row.model]),
              name: row.model,
              detail: row.provider,
              totals: row,
            })),
          )}
        </>
      )}
    </>
  );
}
