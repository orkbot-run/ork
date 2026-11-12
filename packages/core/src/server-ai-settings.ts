// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { RpcInput, RpcOutput } from "@orkbot/contracts";

export function workspaceAIUpdate(
  row: RpcOutput<"serverAI/status">["connections"][number],
  patch: Partial<Omit<RpcInput<"serverAI/configure">, "connectionId">>,
): RpcInput<"serverAI/configure"> {
  return {
    enabled: row.enabled,
    allowedModels: row.allowedModels,
    defaultModelId: row.defaultModelId ?? row.allowedModels[0]!,
    isDefault: row.isDefault,
    fallback: row.fallback,
    priority: row.priority,
    monthlyBudgetMicros: row.monthlyBudgetMicros,
    ...patch,
    connectionId: row.id,
  };
}

/** Parse at most six decimal places without rounding a budget upward through floating point. */
export function parseAIBudget(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!value) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || value.length > 24) throw new Error("Invalid budget");
  const [whole, fraction = ""] = value.split(".");
  const micros = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid budget");
  return Number(micros);
}

export function formatAIBudget(micros: number | null): string {
  if (micros === null) return "";
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("Invalid budget");
  const value = BigInt(micros);
  const fraction = String(value % 1_000_000n)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
