// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { Actor, UsageBreakdown, UsageBreakdownInput, UsageTotals } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { Prisma } from "@orkbot/db";

const DAYS_BEFORE_TODAY = { today: 0, "7d": 6, "30d": 29, all: null } as const;
const MONTHLY_AFTER_DAYS = 60;
const EMPTY_TOTALS: UsageTotals = {
  runs: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

type GroupRow = UsageTotals & {
  botId: string | null;
  provider: string | null;
  model: string | null;
  date: string | null;
  isBot: boolean;
  isModel: boolean;
  isDate: boolean;
};

type BreakdownRows = Pick<
  UsageBreakdown,
  "timezone" | "from" | "to" | "overTimeUnit" | "botOptions" | "modelOptions"
> & { groups: GroupRow[] };

function totals(row: GroupRow): UsageTotals {
  return {
    runs: row.runs,
    modelCalls: row.modelCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
  };
}

/** Dates are calendar labels, independent of the time zone of the API process. */
function timeline(
  from: string | null,
  to: string,
  unit: UsageBreakdown["overTimeUnit"],
  points: ReadonlyMap<string, UsageTotals>,
): UsageBreakdown["overTime"] {
  if (!from) return [];
  const first = unit === "month" ? `${from.slice(0, 7)}-01` : from;
  const cursor = new Date(`${first}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const series: UsageBreakdown["overTime"] = [];
  while (cursor.getTime() <= end) {
    const date = cursor.toISOString().slice(0, 10);
    series.push({ date, ...(points.get(date) ?? EMPTY_TOTALS) });
    if (unit === "month") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return series;
}

export async function loadUsageBreakdown(
  prisma: PrismaClient,
  actor: Pick<Actor, "spaceId" | "userId">,
  input: UsageBreakdownInput,
  now = new Date(),
): Promise<UsageBreakdown> {
  // The range options deliberately ignore the selected bot/model. This keeps alternatives
  // available when another filter returns no data. Sticky predicates still constrain every
  // scan to the acting user and Space. The existing summary counts distinct top-level runs.
  const rows = await prisma.$queryRaw<BreakdownRows[]>`
    WITH zone AS MATERIALIZED (
      SELECT COALESCE(
        (
          SELECT tz.name FROM pg_timezone_names tz
          WHERE tz.name = (SELECT "timezone" FROM "user" WHERE id = ${actor.userId})
        ),
        'UTC'
      ) AS "timezone"
    ),
    bounds AS MATERIALIZED (
      SELECT "timezone",
        (${now.toISOString()}::timestamptz AT TIME ZONE "timezone")::date AS today,
        (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC') AS through_utc,
        (${now.toISOString()}::timestamptz AT TIME ZONE "timezone")::date
          - ${DAYS_BEFORE_TODAY[input.range]}::integer AS start_day
      FROM zone
    ),
    range_calls AS NOT MATERIALIZED (
      SELECT u.*
      FROM usage_records u CROSS JOIN bounds b
      WHERE u."spaceId" = ${actor.spaceId}
        AND u."userId" = ${actor.userId}
        AND u."createdAt" <= b.through_utc
        AND (
          b.start_day IS NULL OR
          u."createdAt" >= ((b.start_day::timestamp AT TIME ZONE b."timezone") AT TIME ZONE 'UTC')
        )
    ),
    calendar AS MATERIALIZED (
      SELECT b.*,
        COALESCE(b.start_day, (
          SELECT (MIN(u."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE b."timezone")::date
          FROM range_calls u WHERE b.start_day IS NULL
        )) AS first_day
      FROM bounds b
    ),
    axis AS MATERIALIZED (
      SELECT c.*,
        CASE WHEN c.start_day IS NULL AND c.today - c.first_day > ${MONTHLY_AFTER_DAYS}
          THEN 'month' ELSE 'day' END AS unit
      FROM calendar c
    ),
    available AS (
      SELECT "botId", provider, model,
        GROUPING("botId") = 0 AS is_bot
      FROM range_calls
      GROUP BY GROUPING SETS (("botId"), (provider, model))
    ),
    selected AS (
      SELECT u.*,
        date_trunc(a.unit, u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE a."timezone")::date AS bucket
      FROM range_calls u CROSS JOIN axis a
      WHERE TRUE
        ${input.botId === undefined ? Prisma.empty : Prisma.sql`AND u."botId" = ${input.botId}`}
        ${input.provider === undefined ? Prisma.empty : Prisma.sql`AND u.provider = ${input.provider}`}
        ${input.model === undefined ? Prisma.empty : Prisma.sql`AND u.model = ${input.model}`}
    ),
    aggregate_groups AS (
      SELECT
        "botId", provider, model, to_char(bucket, 'YYYY-MM-DD') AS date,
        GROUPING("botId") = 0 AS "isBot",
        GROUPING(provider) = 0 AS "isModel",
        GROUPING(bucket) = 0 AS "isDate",
        COUNT(DISTINCT COALESCE("parentRunId", "runId"))::float8 AS runs,
        COUNT(*)::float8 AS "modelCalls",
        CASE WHEN COUNT("inputTokens") = COUNT(*) THEN COALESCE(SUM("inputTokens"), 0)::float8 END AS "inputTokens",
        CASE WHEN COUNT("outputTokens") = COUNT(*) THEN COALESCE(SUM("outputTokens"), 0)::float8 END AS "outputTokens",
        CASE WHEN COUNT("totalTokens") = COUNT(*) THEN COALESCE(SUM("totalTokens"), 0)::float8 END AS "totalTokens",
        CASE WHEN COUNT("costUsd") = COUNT(*) THEN COALESCE(SUM("costUsd"), 0)::float8 END AS "costUsd"
      FROM selected
      GROUP BY GROUPING SETS ((), ("botId"), (provider, model), (bucket))
    )
    SELECT
      a."timezone", to_char(a.first_day, 'YYYY-MM-DD') AS "from",
      to_char(a.today, 'YYYY-MM-DD') AS "to", a.unit AS "overTimeUnit",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'botId', o."botId", 'name', COALESCE(b.name, d.name), 'deleted', b.id IS NULL
        ) ORDER BY COALESCE(b.name, d.name), o."botId")
        FROM available o
        LEFT JOIN bots b
          ON b.id = o."botId" AND b."spaceId" = ${actor.spaceId} AND b."userId" = ${actor.userId}
        LEFT JOIN bot_deletions d ON d.id = o."botId" AND d."spaceId" = ${actor.spaceId}
        WHERE o.is_bot AND o."botId" IS NOT NULL
      ), '[]'::jsonb) AS "botOptions",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('provider', o.provider, 'model', o.model)
          ORDER BY o.provider, o.model)
        FROM available o WHERE NOT o.is_bot
      ), '[]'::jsonb) AS "modelOptions",
      COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM aggregate_groups g), '[]'::jsonb) AS "groups"
    FROM axis a
  `;
  const [row] = rows;
  if (!row) throw new Error("Usage breakdown returned no calendar");
  const { groups, ...calendar } = row;
  const identity = new Map(calendar.botOptions.map((bot) => [bot.botId, bot]));
  const data: UsageBreakdown = {
    ...calendar,
    range: input.range,
    totals: EMPTY_TOTALS,
    bots: [],
    models: [],
    overTime: [],
  };
  const points = new Map<string, UsageTotals>();
  for (const group of groups) {
    if (group.isBot) {
      const bot = group.botId === null ? undefined : identity.get(group.botId);
      data.bots.push({
        botId: group.botId,
        name: bot?.name ?? null,
        deleted: bot?.deleted ?? group.botId !== null,
        ...totals(group),
      });
    } else if (group.isModel && group.provider !== null && group.model !== null) {
      data.models.push({ provider: group.provider, model: group.model, ...totals(group) });
    } else if (group.isDate && group.date !== null) {
      points.set(group.date, totals(group));
    } else {
      data.totals = totals(group);
    }
  }
  data.bots.sort(
    (a, b) => b.modelCalls - a.modelCalls || (a.botId ?? "").localeCompare(b.botId ?? ""),
  );
  data.models.sort(
    (a, b) =>
      b.modelCalls - a.modelCalls ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model),
  );
  data.overTime = timeline(data.from, data.to, data.overTimeUnit, points);
  return data;
}
