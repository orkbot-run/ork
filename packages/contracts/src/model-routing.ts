// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ModelRoutingField, ModelRoutingValues } from "./domain.js";
import { ModelRoutingValuesSchema } from "./domain.js";

/** Validate a complete set of route segments against the declared connection fields. */
export function normalizeModelRouting(
  fields: readonly ModelRoutingField[],
  values: Readonly<Record<string, string>>,
): ModelRoutingValues | undefined {
  if (fields.length > 8 || new Set(fields.map((field) => field.key)).size !== fields.length)
    return undefined;
  const declared = new Set(fields.map((field) => field.key));
  if (Object.keys(values).some((key) => !declared.has(key))) return undefined;
  const normalized = Object.fromEntries(
    fields.flatMap(({ key }) => {
      const value = Object.hasOwn(values, key) ? values[key] : undefined;
      return typeof value === "string" && value.trim() ? [[key, value.trim()]] : [];
    }),
  );
  if (fields.some(({ key, required }) => required && !Object.hasOwn(normalized, key)))
    return undefined;
  const parsed = ModelRoutingValuesSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}
