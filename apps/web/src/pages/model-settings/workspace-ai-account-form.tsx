// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { RpcInput, RpcOutput } from "@orkbot/contracts";
import { formatAIBudget, parseAIBudget } from "@orkbot/core";
import { Button, Input, Label, NativeSelect, NativeSelectOption, Switch } from "@orkbot/ui-web";
import { useId, useState } from "react";

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
  const { t } = useLingui();
  const id = useId();
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
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="grid gap-3">
        <legend className="mb-2 text-sm font-medium">
          <Trans>Allowed models</Trans>
        </legend>
        {row.models.map((value) => (
          <Label key={value} className="flex items-center justify-between gap-3">
            <span className="break-all">{value}</span>
            <Switch
              checked={allowed.includes(value)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...allowed, value]
                  : allowed.filter((entry) => entry !== value);
                setAllowed(next);
                if (!next.includes(model)) setModel(next[0] ?? "");
              }}
            />
          </Label>
        ))}
        <Label htmlFor={`${id}-default`}>
          <Trans>Default model</Trans>
        </Label>
        <NativeSelect
          id={`${id}-default`}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {allowed.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor={`${id}-budget`}>
          <Trans>Monthly budget (USD)</Trans>
        </Label>
        <Input
          id={`${id}-budget`}
          inputMode="decimal"
          placeholder={t`Unlimited`}
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
        />
        <Label htmlFor={`${id}-priority`}>
          <Trans>Fallback priority</Trans>
        </Label>
        <Input
          id={`${id}-priority`}
          type="number"
          min={0}
          max={1000}
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
        />
        {invalid ? (
          <p role="alert" className="text-sm text-destructive">
            <Trans>Choose at least one model and enter valid limits.</Trans>
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={!allowed.length}>
            <Trans>Save</Trans>
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        </div>
      </fieldset>
    </form>
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
  const { t } = useLingui();
  const id = useId();
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
    <form
      className="grid gap-3 border-b border-border pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Label htmlFor={id}>
        <Trans>Workspace monthly budget (USD)</Trans>
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        placeholder={t`Unlimited`}
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      />
      {invalid ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Enter a valid budget.</Trans>
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={busy || value === formatAIBudget(budget)}>
        <Trans>Save budget</Trans>
      </Button>
    </form>
  );
}
