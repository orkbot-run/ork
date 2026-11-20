// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { McpFormField, McpFormRequest } from "@orkbot/contracts";
import { MCP_FORM_MAX_FIELDS, MCP_FORM_MAX_OPTIONS, McpFormRequestSchema } from "@orkbot/contracts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SENSITIVE_FORM =
  /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|credit[_ -]?card|card[_ -]?(?:number|details)|payment[_ -]?details|\bcvv\b|\bcvc\b)/iu;

function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return secrets.some((secret) => secret.length > 0 && String(value).includes(secret));
  }
  if (Array.isArray(value)) return value.some((child) => containsSecret(child, secrets));
  return (
    object(value) &&
    Object.entries(value).some(
      ([key, child]) => containsSecret(key, secrets) || containsSecret(child, secrets),
    )
  );
}

/** Reject unsupported schema semantics instead of silently collecting a different answer. */
export function mcpFormRequest(
  integrationName: string,
  params: Record<string, unknown>,
  secrets: readonly string[] = [],
): McpFormRequest | undefined {
  if (params.mode !== undefined && params.mode !== "form") return;
  if (typeof params.message === "string" && SENSITIVE_FORM.test(params.message)) return;
  const schema = params.requestedSchema;
  if (!object(schema) || schema.type !== "object" || !object(schema.properties)) return;
  if (
    Object.keys(schema).some(
      (key) => !["type", "properties", "required", "additionalProperties"].includes(key),
    )
  )
    return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return;
  const entries = Object.entries(schema.properties);
  if (entries.length > MCP_FORM_MAX_FIELDS) return;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (key) => typeof key !== "string" || !Object.hasOwn(schema.properties as object, key),
    )
  )
    return;
  const fields: McpFormField[] = [];
  for (const [name, source] of entries) {
    if (!object(source)) return;
    const common = ["type", "title", "description", "default"];
    let allowed: string[];
    let type: McpFormField["type"];
    let options: McpFormField["options"];
    if (source.type === "string") {
      allowed = [...common, "format", "minLength", "maxLength", "enum", "enumNames", "oneOf"];
      type = (source.format ?? "string") as McpFormField["type"];
      if (!["string", "date", "date-time", "email", "uri"].includes(type)) return;
      if (source.enum !== undefined || source.oneOf !== undefined) {
        if (
          source.format !== undefined ||
          (source.enum !== undefined && source.oneOf !== undefined)
        )
          return;
        type = "enum";
        if (Array.isArray(source.enum)) {
          if (
            source.enum.length > MCP_FORM_MAX_OPTIONS ||
            source.enum.some((value) => typeof value !== "string")
          )
            return;
          if (
            source.enumNames !== undefined &&
            (!Array.isArray(source.enumNames) || source.enumNames.length !== source.enum.length)
          )
            return;
          options = source.enum.map((value, index) => ({
            value,
            label: (source.enumNames as string[] | undefined)?.[index] ?? value,
          }));
        } else if (Array.isArray(source.oneOf)) {
          if (
            source.oneOf.length > MCP_FORM_MAX_OPTIONS ||
            source.oneOf.some(
              (item) =>
                !object(item) ||
                Object.keys(item).some((key) => key !== "const" && key !== "title"),
            )
          )
            return;
          options = source.oneOf.map((item) => ({ value: item.const, label: item.title }));
        } else return;
      } else if (source.enumNames !== undefined) return;
    } else if (source.type === "number" || source.type === "integer") {
      type = source.type;
      allowed = [...common, "minimum", "maximum"];
    } else if (source.type === "boolean") {
      type = "boolean";
      allowed = common;
    } else return;
    if (Object.keys(source).some((key) => !allowed.includes(key))) return;
    // Form elicitation must not request credentials or payment card data.
    if (SENSITIVE_FORM.test(`${name} ${source.title ?? ""} ${source.description ?? ""}`)) return;
    fields.push({
      name,
      type,
      required: required.includes(name),
      options,
      title: source.title as string | undefined,
      description: source.description as string | undefined,
      default: source.default as McpFormField["default"],
      minLength: source.minLength as number | undefined,
      maxLength: source.maxLength as number | undefined,
      minimum: source.minimum as number | undefined,
      maximum: source.maximum as number | undefined,
    });
  }
  const parsed = McpFormRequestSchema.safeParse({
    integrationName,
    message: params.message,
    fields,
  });
  if (!parsed.success) return;
  // Refuse the entire request if safe presentation would change names/defaults/options.
  if (containsSecret(parsed.data, secrets)) return;
  return parsed.data;
}
