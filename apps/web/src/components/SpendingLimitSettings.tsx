// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { SpendingLimit, SpendingLimitState } from "@orkbot/contracts";
import {
  SpendingCurrencySchema,
  SpendingLimitSchema,
  SpendingPeriodSchema,
} from "@orkbot/contracts";
import { writeSaved } from "@orkbot/core/query";
import { Button, Input, NativeSelect, NativeSelectOption } from "@orkbot/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

/** Spending always belongs to the account, including purchases in other Spaces. */
export function SpendingLimitSettings() {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const query = useQuery(queries.spendingLimit.get.queryOptions({ input: {} }));
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<SpendingLimit["currency"]>("USD");
  const [period, setPeriod] = useState<SpendingLimit["period"]>("monthly");
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const periods: Record<SpendingLimit["period"], string> = {
    daily: t`Daily`,
    weekly: t`Weekly`,
    monthly: t`Monthly`,
    never: t`Never`,
  };
  const limit = query.data?.limit;
  const parsed = SpendingLimitSchema.safeParse({
    amount: /^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(amount.trim())
      ? Number(amount.replace(",", "."))
      : Number.NaN,
    currency,
    period,
  });
  const disabled = saving || query.isPending || Boolean(query.error);
  const error =
    actionError ?? (query.error ? errorText(query.error, t`Could not load spending limit`) : null);

  function edit() {
    setAmount(limit ? String(limit.amount) : "");
    setCurrency(limit?.currency ?? "USD");
    setPeriod(limit?.period ?? "monthly");
    setError(null);
    setEditing(true);
  }

  async function save(next: SpendingLimit | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved: SpendingLimitState = await rpc.spendingLimit.set({ limit: next });
      await writeSaved(queryClient, queries.spendingLimit.get.queryKey({ input: {} }), () => saved);
      setEditing(false);
    } catch (err) {
      setError(errorText(err, t`Could not save spending limit`));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup
      title={<Trans>Account spending limit</Trans>}
      data-testid="spending-limit-settings"
    >
      {editing ? (
        <form
          className="divide-y divide-border"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.success && !disabled) void save(parsed.data);
          }}
        >
          <SettingsRow
            label={<Trans>Amount</Trans>}
            control={
              <Input
                aria-label={t`Amount`}
                className="w-36"
                inputMode="decimal"
                value={amount}
                disabled={saving}
                onChange={(event) => setAmount(event.target.value)}
                maxLength={15}
              />
            }
          />
          <SettingsRow
            label={<Trans>Currency</Trans>}
            control={
              <NativeSelect
                aria-label={t`Currency`}
                value={currency}
                disabled={saving}
                onChange={(event) => {
                  const next = SpendingCurrencySchema.safeParse(event.target.value);
                  if (next.success) setCurrency(next.data);
                }}
              >
                {SpendingCurrencySchema.options.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            }
          />
          <SettingsRow
            label={<Trans>Reset period (UTC)</Trans>}
            control={
              <NativeSelect
                aria-label={t`Reset period (UTC)`}
                value={period}
                disabled={saving}
                onChange={(event) => {
                  const next = SpendingPeriodSchema.safeParse(event.target.value);
                  if (next.success) setPeriod(next.data);
                }}
              >
                {SpendingPeriodSchema.options.map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {periods[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            }
          />
          <div className="flex justify-end gap-2 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" size="sm" disabled={disabled || !parsed.success}>
              <Trans>Save limit</Trans>
            </Button>
          </div>
        </form>
      ) : (
        <>
          <SettingsRow
            label={
              limit ? (
                `${limit.currency} ${limit.amount.toFixed(2)} · ${periods[limit.period]}`
              ) : (
                <Trans>No limit</Trans>
              )
            }
            control={
              <>
                <Button variant="outline" size="sm" disabled={disabled} onClick={edit}>
                  {limit ? <Trans>Edit limit</Trans> : <Trans>Set limit</Trans>}
                </Button>
                {limit ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void save(null)}
                  >
                    <Trans>Remove limit</Trans>
                  </Button>
                ) : null}
              </>
            }
          />
          {limit ? (
            <SettingsRow
              label={<Trans>Spent and reserved</Trans>}
              control={
                <span className="text-sm text-muted-foreground">
                  {limit.currency} {query.data?.spent.toFixed(2)}
                </span>
              }
            />
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="px-4 py-3 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      {query.error ? (
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
    </SettingsGroup>
  );
}
