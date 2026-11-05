// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { SpendingLimit, SpendingLimitState } from "@orkbot/contracts";
import {
  SpendingCurrencySchema,
  SpendingLimitSchema,
  SpendingPeriodSchema,
} from "@orkbot/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPickerMenu } from "./menu-picker";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

/** Account spending has no Space override. The server combines purchases from every bot. */
export function SpendingLimitSettings() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [state, setState] = useState<SpendingLimitState | null>(null);
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<SpendingLimit["currency"]>("USD");
  const [period, setPeriod] = useState<SpendingLimit["period"]>("monthly");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saves = useRef(0);
  const busy = useRef(false);
  const periods: Record<SpendingLimit["period"], string> = {
    daily: t("Daily"),
    weekly: t("Weekly"),
    monthly: t("Monthly"),
    never: t("Never"),
  };
  const parsed = SpendingLimitSchema.safeParse({
    amount: /^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/.test(amount.trim())
      ? Number(amount.replace(",", "."))
      : Number.NaN,
    currency,
    period,
  });

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const version = saves.current;
      void rpc("spendingLimit/get", {})
        .then((next) => {
          if (current && version === saves.current) {
            setState(next);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (current && version === saves.current)
            setError(errorText(err, t("Could not load spending limit")));
        });
      return () => {
        current = false;
      };
    }, [attempt, t]),
  );

  function edit() {
    if (!state || busy.current) return;
    setAmount(state.limit ? String(state.limit.amount) : "");
    setCurrency(state.limit?.currency ?? "USD");
    setPeriod(state.limit?.period ?? "monthly");
    setError(null);
    setEditing(true);
  }

  async function save(limit: SpendingLimit | null) {
    if (busy.current) return;
    busy.current = true;
    saves.current += 1;
    setSaving(true);
    setError(null);
    try {
      setState(await rpc("spendingLimit/set", { limit }));
      setEditing(false);
    } catch (err) {
      setError(errorText(err, t("Could not save spending limit")));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <SettingsGroup label={t("Account spending limit")}>
      {editing
        ? [
            <SettingsInputRow
              key="amount"
              accessibilityLabel={t("Amount")}
              placeholder={t("Amount")}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              editable={!saving}
              maxLength={15}
            />,
            <MenuPickerMenu
              key="currency"
              label={t("Currency")}
              choices={SpendingCurrencySchema.options.map((key) => ({ key, label: key }))}
              value={currency}
              disabled={saving}
              onChange={(key) => {
                const next = SpendingCurrencySchema.safeParse(key);
                if (next.success) setCurrency(next.data);
              }}
            >
              <View>
                <SettingsRow
                  title={t("Currency")}
                  value={currency}
                  accessibilityLabel={t("Currency")}
                  accessibilityRole="button"
                />
              </View>
            </MenuPickerMenu>,
            <MenuPickerMenu
              key="period"
              label={t("Reset period (UTC)")}
              choices={SpendingPeriodSchema.options.map((key) => ({ key, label: periods[key] }))}
              value={period}
              disabled={saving}
              onChange={(key) => {
                const next = SpendingPeriodSchema.safeParse(key);
                if (next.success) setPeriod(next.data);
              }}
            >
              <View>
                <SettingsRow
                  title={t("Reset period (UTC)")}
                  value={periods[period]}
                  accessibilityLabel={t("Reset period (UTC)")}
                  accessibilityRole="button"
                />
              </View>
            </MenuPickerMenu>,
            <SettingsRow
              key="save"
              title={t("Save limit")}
              accessibilityRole="button"
              disabled={saving || !parsed.success}
              dimmed={saving || !parsed.success}
              onPress={() => {
                if (parsed.success) void save(parsed.data);
              }}
            />,
            <SettingsRow
              key="cancel"
              title={t("Cancel")}
              accessibilityRole="button"
              disabled={saving}
              onPress={() => {
                setEditing(false);
                setError(null);
              }}
            />,
          ]
        : [
            <SettingsRow
              key="summary"
              title={
                state?.limit
                  ? `${state.limit.currency} ${state.limit.amount.toFixed(2)} · ${periods[state.limit.period]}`
                  : t("No limit")
              }
              value={state?.limit ? t("Edit limit") : t("Set limit")}
              accessibilityLabel={t("Spending limit")}
              accessibilityRole="button"
              disabled={!state || saving}
              dimmed={!state || saving}
              onPress={edit}
            />,
            state?.limit ? (
              <SettingsRow
                key="spent"
                title={t("Spent and reserved")}
                value={`${state.limit.currency} ${state.spent.toFixed(2)}`}
              />
            ) : null,
            state?.limit ? (
              <SettingsRow
                key="remove"
                title={t("Remove limit")}
                accessibilityRole="button"
                destructive
                disabled={saving}
                onPress={() => void save(null)}
              />
            ) : null,
          ]}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive, padding: 16 }}>
          {error}
        </Text>
      ) : null}
      {error && !state ? (
        <SettingsRow
          title={t("Retry")}
          accessibilityRole="button"
          onPress={() => setAttempt((count) => count + 1)}
        />
      ) : null}
    </SettingsGroup>
  );
}
