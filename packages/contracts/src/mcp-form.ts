// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import * as z from "zod";

export const MCP_FORM_MAX_FIELDS = 24;
export const MCP_FORM_MAX_VALUE_LENGTH = 2048;
export const MCP_FORM_MAX_OPTIONS = 32;
export const MCP_FORM_MAX_ANSWER_LENGTH = 330_000;

const fieldName = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) => !/\p{Cc}/u.test(name) && !["__proto__", "constructor", "prototype"].includes(name),
  );
const scalar = z.union([z.string().max(MCP_FORM_MAX_VALUE_LENGTH), z.number(), z.boolean()]);
const isoDate = z.iso.date();
const dateTime = z.iso
  .datetime({ offset: true })
  .refine((value) => /T\d{2}:\d{2}:\d{2}/u.test(value));
const email = z.email();
const uri = z.url();

export const McpFormFieldSchema = z.strictObject({
  name: fieldName,
  title: z.string().max(160).optional(),
  description: z.string().max(1200).optional(),
  required: z.boolean(),
  type: z.enum([
    "string",
    "number",
    "integer",
    "boolean",
    "enum",
    "date",
    "date-time",
    "email",
    "uri",
  ]),
  default: scalar.optional(),
  options: z
    .array(
      z.strictObject({
        value: z.string().max(MCP_FORM_MAX_VALUE_LENGTH),
        label: z.string().max(160),
      }),
    )
    .min(1)
    .max(MCP_FORM_MAX_OPTIONS)
    .optional(),
  minLength: z.number().int().min(0).max(MCP_FORM_MAX_VALUE_LENGTH).optional(),
  maxLength: z.number().int().min(0).max(MCP_FORM_MAX_VALUE_LENGTH).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});
export type McpFormField = z.infer<typeof McpFormFieldSchema>;

export function validateMcpFormValue(field: McpFormField, value: unknown): boolean {
  if (value === undefined) return !field.required;
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "number" || field.type === "integer") {
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isSafeInteger(value)) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum)
    );
  }
  if (typeof value !== "string" || value.includes("\0") || value.length > MCP_FORM_MAX_VALUE_LENGTH)
    return false;
  const length = [...value].length;
  if (length < (field.minLength ?? 0) || length > (field.maxLength ?? MCP_FORM_MAX_VALUE_LENGTH))
    return false;
  switch (field.type) {
    case "enum":
      return field.options?.some((option) => option.value === value) ?? false;
    case "date":
      return isoDate.safeParse(value).success;
    case "date-time":
      return dateTime.safeParse(value).success;
    case "email":
      return email.safeParse(value).success;
    case "uri":
      return uri.safeParse(value).success;
    default:
      return true;
  }
}

const fields = z
  .array(McpFormFieldSchema)
  .max(MCP_FORM_MAX_FIELDS)
  .refine((items) => {
    if (new Set(items.map(({ name }) => name)).size !== items.length) return false;
    return items.every(
      (field) =>
        (field.type === "enum"
          ? field.options &&
            new Set(field.options.map(({ value }) => value)).size === field.options.length
          : !field.options) &&
        (field.minLength === undefined ||
          field.maxLength === undefined ||
          field.minLength <= field.maxLength) &&
        (field.minimum === undefined ||
          field.maximum === undefined ||
          field.minimum <= field.maximum) &&
        (field.default === undefined || validateMcpFormValue(field, field.default)),
    );
  });

export const McpFormRequestSchema = z.strictObject({
  integrationName: z.string().min(1).max(160),
  message: z.string().trim().min(1).max(2400),
  fields,
});
export type McpFormRequest = z.infer<typeof McpFormRequestSchema>;

export const McpFormCardSchema = McpFormRequestSchema.omit({ message: true }).extend({
  id: z.uuid(),
  ownerUserId: z.string().min(1).max(128).optional(),
  status: z.enum(["pending", "accepted", "declined", "cancelled", "expired"]),
});
export type McpFormCard = z.infer<typeof McpFormCardSchema>;

const content = z.preprocess(
  // Validate raw keys before the validator can discard prototype keys.
  (value) =>
    value &&
    typeof value === "object" &&
    Object.keys(value).every((name) => fieldName.safeParse(name).success)
      ? value
      : null,
  z.record(fieldName, scalar),
);
const accept = { action: z.literal("accept"), content };
const refuse = { action: z.enum(["decline", "cancel"]) };
export const McpFormResponseSchema = z.discriminatedUnion("action", [
  z.strictObject(accept),
  z.strictObject(refuse),
]);
export type McpFormResponse = z.infer<typeof McpFormResponseSchema>;

export const McpFormAnswerSchema = z.discriminatedUnion("action", [
  z.strictObject({ mcpFormId: z.uuid(), ...accept }),
  z.strictObject({ mcpFormId: z.uuid(), ...refuse }),
]);

export function validateMcpFormResponse(
  fields: readonly McpFormField[],
  response: McpFormResponse,
): boolean {
  if (response.action !== "accept") return true;
  const { content } = response;
  const names = new Set(fields.map(({ name }) => name));
  return (
    Object.keys(content).every((name) => names.has(name)) &&
    fields.every((field) =>
      validateMcpFormValue(
        field,
        Object.hasOwn(content, field.name) ? content[field.name] : undefined,
      ),
    )
  );
}
