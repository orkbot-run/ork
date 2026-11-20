// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors (inherited material)
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited UTF-16 protection is preserved; identity-label filtering is an Ork addition.

import { sanitizeJsonValue, sanitizeUtf16ForJson, stripDirectionalControls } from "@orkbot/core";
import type { PrismaClient } from "./generated/prisma/client.js";

const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const WRITE_KEYS = ["data", "create", "update"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy-on-change: untouched values keep their identity. Dates, bytes, and decimals pass through. */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeUtf16ForJson(value);
  if (Array.isArray(value)) {
    const items = value.map(sanitizeValue);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  // Only JSON can carry such a key (Prisma field names cannot); keep colliding keys apart.
  if (keys.some((key) => sanitizeUtf16ForJson(key) !== key)) return sanitizeJsonValue(value);
  return sanitizeEntries(value, keys);
}

function sanitizeEntries(value: Record<string, unknown>, keys: readonly string[]) {
  let out: Record<string, unknown> | undefined;
  for (const key of keys) {
    if (!(key in value)) continue;
    const next = sanitizeValue(value[key]);
    if (next === value[key]) continue;
    out ??= { ...value };
    out[key] = next;
  }
  return out ?? value;
}

/**
 * Postgres rejects NUL in text columns, and NUL or an unpaired surrogate in json, so one such
 * character in pasted or tool-produced text would fail the whole write. Replace them in every
 * written value. Filters are left alone: they read rows and cannot store anything.
 */
export function sanitizeWriteArgs(operation: string, args: unknown): unknown {
  if (!WRITE_OPERATIONS.has(operation) || !isPlainObject(args)) return args;
  return sanitizeEntries(args, WRITE_KEYS);
}

type ModelField = { name: string; kind: string; type: string };
type RuntimeDataModel = { models: Record<string, { fields: ModelField[] }> };
const NESTED_WRITE_KEYS = new Set([
  "data",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "connectOrCreate",
]);

// Filtering is restricted to human identities. Operational names (secret keys,
// skill/tool identifiers, filenames) must retain their exact value.
const DISPLAY_FIELDS: Record<string, readonly string[]> = {
  User: ["name"],
  UserDevice: ["name"],
  Passkey: ["name"],
  Organization: ["name"],
  Space: ["name"],
  Bot: ["name"],
  BotSection: ["name"],
  BotDeletion: ["name"],
  ChatGroup: ["name"],
  Page: ["title"],
  PageVersion: ["title"],
  AuditEvent: ["spaceName", "actorLabel", "targetLabel"],
  Connection: ["displayName"],
  MessagingChannel: ["name"],
  MessagingInstallation: ["workspaceName"],
  ExternalConversation: ["displayName", "participantNames"],
  ExternalMessage: ["senderName"],
};

function displayFields(fields: Map<string, Map<string, ModelField>>) {
  const projected = new Map<string, Map<string, ModelField>>();
  for (const [model, names] of Object.entries(DISPLAY_FIELDS)) {
    const selected = [...(fields.get(model)?.values() ?? [])].filter((field) =>
      names.includes(field.name),
    );
    if (selected.length)
      projected.set(model, new Map(selected.map((field) => [field.name, field])));
  }
  // Keep only relations that can reach display fields; unrelated models have a fast path.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [model, modelFields] of fields) {
      for (const field of modelFields.values()) {
        if (
          field.kind !== "object" ||
          !projected.has(field.type) ||
          projected.get(model)?.has(field.name)
        )
          continue;
        if (!projected.has(model)) projected.set(model, new Map());
        projected.get(model)?.set(field.name, field);
        changed = true;
      }
    }
  }
  return projected;
}

function mapValues(
  value: Record<string, unknown>,
  transform: (key: string, item: unknown) => unknown,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value)) {
    const next = transform(key, item);
    if (next === item) continue;
    out ??= { ...value };
    out[key] = next;
  }
  return out ?? value;
}

function mapArray(value: unknown[], transform: (item: unknown) => unknown): unknown[] {
  const next = value.map(transform);
  return next.some((item, i) => item !== value[i]) ? next : value;
}

/** Only string scalar values and Prisma's string/list update operators carry names. */
function sanitizeIdentity(value: unknown): unknown {
  if (typeof value === "string") return stripDirectionalControls(value);
  if (Array.isArray(value)) return mapArray(value, sanitizeIdentity);
  if (!isPlainObject(value)) return value;
  return mapValues(value, (key, item) =>
    key === "set" || key === "push" ? sanitizeIdentity(item) : item,
  );
}

/**
 * Resolve every field through the Prisma model, never by inspecting JSON payload keys.
 * Write envelopes recurse only through mutation keys, leaving filters and connect keys alone.
 * Result projection covers existing/imported names without rewriting stored records.
 */
function sanitizeModelNames(
  value: unknown,
  model: string,
  fields: Map<string, Map<string, ModelField>>,
  writing: boolean,
): unknown {
  const modelFields = fields.get(model);
  if (!modelFields?.size) return value;
  if (Array.isArray(value))
    return mapArray(value, (item) => sanitizeModelNames(item, model, fields, writing));
  if (!isPlainObject(value)) return value;
  return mapValues(value, (key, item) => {
    const field = modelFields?.get(key);
    if (field?.kind === "object") return sanitizeModelNames(item, field.type, fields, writing);
    if (field?.kind === "scalar" && field.type === "String" && DISPLAY_FIELDS[model]?.includes(key))
      return sanitizeIdentity(item);
    if (!field && writing && NESTED_WRITE_KEYS.has(key))
      return sanitizeModelNames(item, model, fields, writing);
    return item;
  });
}

export function withTextSanitization(prisma: PrismaClient): PrismaClient {
  const dataModel = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModel })
    ._runtimeDataModel;
  if (!dataModel?.models) throw new Error("Prisma runtime data model is unavailable");
  const fields = new Map(
    Object.entries(dataModel.models).map(([model, { fields }]) => [
      model,
      new Map(fields.map((field) => [field.name, field])),
    ]),
  );
  const projectedFields = displayFields(fields);
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const safeArgs = sanitizeWriteArgs(operation, args);
          const input =
            WRITE_OPERATIONS.has(operation) && isPlainObject(safeArgs)
              ? mapValues(safeArgs, (key, value) =>
                  WRITE_KEYS.includes(key as (typeof WRITE_KEYS)[number])
                    ? sanitizeModelNames(value, model, fields, true)
                    : value,
                )
              : safeArgs;
          const result = await query(input as typeof args);
          return sanitizeModelNames(result, model, projectedFields, false);
        },
      },
    },
  }) as unknown as PrismaClient;
}
