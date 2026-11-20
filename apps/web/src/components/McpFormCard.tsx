// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { useLingui } from "@lingui/react/macro";
import { useMcpForm } from "@orkbot/chat-ui/mcp-form";
import { Button, Input } from "@orkbot/ui-web";
import { useId } from "react";
import type { AskCardProps } from "./AskCard";
import { BuiCard } from "./ai/primitives";

export function McpFormCard({ block, canAnswer, onAnswer }: AskCardProps) {
  const { t } = useLingui();
  const form = block.mcpForm!;
  const state = useMcpForm(form, canAnswer && block.status !== "answered", onAnswer);
  const id = useId();
  const editable = state.active && !state.pending;
  return (
    <BuiCard data-testid="mcp-form-card" className="w-full min-w-0 max-w-xl space-y-3 px-5 py-4">
      <p className="text-sm text-muted-foreground">{form.integrationName}</p>
      <h3 id={`${id}-title`} className="text-base font-medium whitespace-pre-wrap break-words">
        {block.text}
      </h3>
      {state.active ? (
        <form
          aria-labelledby={`${id}-title`}
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void state.submit("accept");
          }}
        >
          {form.fields.map((field, index) => {
            const fieldId = `${id}-${index}`;
            const label = field.title ?? field.name;
            const options =
              field.type === "boolean"
                ? [
                    { value: "true", label: t`Yes` },
                    { value: "false", label: t`No` },
                  ]
                : field.options;
            const value = state.values[field.name];
            const invalid = state.invalidFields.has(field.name);
            return (
              <div key={field.name} className="space-y-1">
                <label htmlFor={fieldId} className="text-sm font-medium">
                  {label}
                  {field.required ? ` (${t`Required`})` : ` (${t`Optional`})`}
                </label>
                {field.description ? (
                  <p
                    id={`${fieldId}-help`}
                    className="text-sm text-muted-foreground whitespace-pre-wrap break-words"
                  >
                    {field.description}
                  </p>
                ) : null}
                {field.type === "date-time" ? (
                  <p
                    id={`${fieldId}-format`}
                    className="text-sm text-muted-foreground"
                  >{t`Use a date and time with timezone, e.g. 2026-11-20T14:30:00+01:00`}</p>
                ) : null}
                {options ? (
                  <select
                    id={fieldId}
                    name={field.name}
                    aria-invalid={invalid}
                    required={field.required}
                    disabled={!editable}
                    className="min-h-12 w-full rounded-md border border-input bg-background px-3 text-base"
                    value={
                      value === undefined
                        ? ""
                        : String(options.findIndex((option) => option.value === String(value)))
                    }
                    aria-describedby={
                      [field.description && `${fieldId}-help`, invalid && `${fieldId}-error`]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onChange={(event) =>
                      state.edit(
                        field.name,
                        event.target.value === ""
                          ? undefined
                          : field.type === "boolean"
                            ? options[Number(event.target.value)]!.value === "true"
                            : options[Number(event.target.value)]!.value,
                      )
                    }
                  >
                    <option value="">{t`Choose a value`}</option>
                    {options.map((option, optionIndex) => (
                      <option key={option.value} value={String(optionIndex)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={fieldId}
                    name={field.name}
                    aria-invalid={invalid}
                    required={field.required}
                    disabled={!editable}
                    type={
                      field.type === "number" || field.type === "integer"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : field.type === "email"
                            ? "email"
                            : "text"
                    }
                    step={field.type === "integer" ? 1 : "any"}
                    min={field.minimum}
                    max={field.maximum}
                    minLength={field.minLength}
                    maxLength={field.maxLength ?? 2048}
                    aria-describedby={
                      [
                        field.description && `${fieldId}-help`,
                        field.type === "date-time" && `${fieldId}-format`,
                        invalid && `${fieldId}-error`,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    value={String(value ?? "")}
                    onChange={(event) => state.edit(field.name, event.target.value)}
                  />
                )}
                {invalid ? (
                  <p
                    id={`${fieldId}-error`}
                    className="text-sm text-destructive"
                  >{t`Check the required fields and value formats.`}</p>
                ) : null}
              </div>
            );
          })}
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error === "invalid"
                ? t`Check the required fields and value formats.`
                : t`Could not submit this answer`}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-12" disabled={!editable}>
              {state.pending ? t`Sending…` : t`Submit`}
            </Button>
            <Button
              type="button"
              className="min-h-12"
              variant="outline"
              disabled={!editable}
              onClick={() => void state.submit("decline")}
            >{t`Decline`}</Button>
            <Button
              type="button"
              className="min-h-12"
              variant="outline"
              disabled={!editable}
              onClick={() => void state.submit("cancel")}
            >{t`Cancel`}</Button>
          </div>
        </form>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {state.status === "expired"
            ? t`Expired`
            : state.status === "accepted"
              ? t`Answered`
              : state.status === "declined"
                ? t`Declined`
                : state.status === "cancelled"
                  ? t`Cancelled`
                  : t`Pending`}
        </p>
      )}
    </BuiCard>
  );
}
