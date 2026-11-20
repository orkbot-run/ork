// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { McpFormField, McpFormResponse } from "@orkbot/contracts";
import { validateMcpFormResponse, validateMcpFormValue } from "@orkbot/contracts";
import { useRef, useState } from "react";

type Form = { id: string; fields: McpFormField[]; status: string };
export type McpFormValues = Record<string, string | boolean | undefined>;

export function mcpFormContent(fields: McpFormField[], values: McpFormValues) {
  const content: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || (value === "" && field.type !== "enum")) continue;
    content[field.name] =
      field.type === "number" || field.type === "integer" ? Number(value) : value;
  }
  return content;
}

/** Form values stay in component memory and leave only in the explicit accept response. */
export function useMcpForm(
  form: Form,
  enabled: boolean,
  onAnswer: (answer: string) => Promise<void>,
) {
  const [values, setValues] = useState<McpFormValues>(() =>
    Object.fromEntries(
      form.fields
        .filter((field) => field.default !== undefined)
        .map((field) => [
          field.name,
          typeof field.default === "boolean" ? field.default : String(field.default),
        ]),
    ),
  );
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<McpFormResponse["action"]>();
  const [error, setError] = useState<"invalid" | "submit">();
  const locked = useRef(false);
  const active = enabled && form.status === "pending" && !submitted;
  function edit(name: string, value: string | boolean | undefined) {
    setValues((current) => ({ ...current, [name]: value }));
    setError(undefined);
  }
  async function submit(action: McpFormResponse["action"]) {
    if (!active || locked.current) return;
    const response: McpFormResponse =
      action === "accept" ? { action, content: mcpFormContent(form.fields, values) } : { action };
    if (!validateMcpFormResponse(form.fields, response)) {
      setError("invalid");
      return;
    }
    locked.current = true;
    setPending(true);
    setError(undefined);
    try {
      await onAnswer(JSON.stringify({ mcpFormId: form.id, ...response }));
      setSubmitted(action);
      setValues({});
    } catch {
      setError("submit");
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  const content = mcpFormContent(form.fields, values);
  const invalidFields = new Set(
    error === "invalid"
      ? form.fields
          .filter((field) => !validateMcpFormValue(field, content[field.name]))
          .map((field) => field.name)
      : [],
  );
  const status =
    form.status === "pending" && submitted
      ? ({ accept: "accepted", decline: "declined", cancel: "cancelled" } as const)[submitted]
      : form.status;
  return { values, edit, pending, submitted, status, error, invalidFields, active, submit };
}
