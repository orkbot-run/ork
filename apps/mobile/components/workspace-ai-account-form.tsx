// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcInput, RpcOutput } from "@orkbot/contracts";
import { formatAIBudget, parseAIBudget } from "@orkbot/core";
import { useState } from "react";
import { Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { MenuPickerMenu } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { SettingsGroup, SettingsInputRow, SettingsRow, SettingsSwitch } from "./settings-group";

type Assignment = RpcOutput<"serverAI/status">["connections"][number];
export function WorkspaceAIAccountForm({
  row,
  busy,
  onSave,
  onCancel,
}: {
  row: Assignment;
  busy: boolean;
  onSave(patch: Partial<RpcInput<"serverAI/configure">>): Promise<boolean>;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState(
    row.allowedModels.filter((model) => row.models.includes(model)),
  );
  const [model, setModel] = useState(
    allowed.includes(row.defaultModelId ?? "") ? row.defaultModelId! : (allowed[0] ?? ""),
  );
  const [budget, setBudget] = useState(formatAIBudget(row.monthlyBudgetMicros));
  const [priority, setPriority] = useState(String(row.priority));
  const [invalid, setInvalid] = useState(false);
  async function save() {
    setInvalid(false);
    try {
      const monthlyBudgetMicros = parseAIBudget(budget);
      if (!/^\d+$/.test(priority) || Number(priority) > 1000 || !allowed.includes(model)) {
        setInvalid(true);
        return;
      }
      if (
        await onSave({
          allowedModels: allowed,
          defaultModelId: model,
          monthlyBudgetMicros,
          priority: Number(priority),
        })
      )
        onCancel();
    } catch {
      setInvalid(true);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <SettingsGroup label={t("Allowed models")}>
        {row.models.map((value) => (
          <SettingsSwitch
            key={value}
            label={value}
            value={allowed.includes(value)}
            disabled={busy}
            onChange={(checked) => {
              const next = checked
                ? [...allowed, value]
                : allowed.filter((entry) => entry !== value);
              setAllowed(next);
              if (!next.includes(model)) setModel(next[0] ?? "");
            }}
          />
        ))}
        <MenuPickerMenu
          label={t("Default model")}
          choices={allowed.map((value) => ({ key: value, label: value }))}
          value={model}
          disabled={busy || !allowed.length}
          onChange={setModel}
        >
          <View>
            <SettingsRow title={t("Default model")} value={model} chevron="down" />
          </View>
        </MenuPickerMenu>
        <SettingsInputRow
          accessibilityLabel={t("Monthly budget (USD)")}
          placeholder={t("Monthly budget (USD)")}
          keyboardType="decimal-pad"
          value={budget}
          onChangeText={setBudget}
          editable={!busy}
        />
        <SettingsInputRow
          accessibilityLabel={t("Fallback priority")}
          placeholder={t("Fallback priority")}
          keyboardType="number-pad"
          value={priority}
          onChangeText={setPriority}
          editable={!busy}
        />
      </SettingsGroup>
      {invalid ? (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {t("Choose at least one model and enter valid limits.")}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Save")}
        busy={busy}
        disabled={!allowed.length}
        onPress={() => void save()}
      />
      <NativeActionButton
        label={t("Cancel")}
        prominence="secondary"
        disabled={busy}
        onPress={onCancel}
      />
    </View>
  );
}

export function WorkspaceAIBudgetForm({
  budget,
  busy,
  onSave,
}: {
  budget: number | null;
  busy: boolean;
  onSave(value: number | null): Promise<boolean>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(formatAIBudget(budget));
  const [invalid, setInvalid] = useState(false);
  async function save() {
    setInvalid(false);
    try {
      await onSave(parseAIBudget(value));
    } catch {
      setInvalid(true);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <SettingsGroup label={t("Workspace monthly budget (USD)")}>
        <SettingsInputRow
          accessibilityLabel={t("Workspace monthly budget (USD)")}
          placeholder={t("Unlimited")}
          keyboardType="decimal-pad"
          value={value}
          onChangeText={setValue}
          editable={!busy}
        />
      </SettingsGroup>
      {invalid ? (
        <Text accessibilityRole="alert" style={{ color: native.label }}>
          {t("Enter a valid budget.")}
        </Text>
      ) : null}
      <NativeActionButton
        label={t("Save budget")}
        prominence="secondary"
        busy={busy}
        disabled={value === formatAIBudget(budget)}
        onPress={() => void save()}
      />
    </View>
  );
}
