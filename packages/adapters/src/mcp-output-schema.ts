// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { getLogger, redactSensitiveText } from "@orkbot/logging";

type Issue = "pattern_repaired" | "pattern_omitted" | "schema_validation_unavailable";
type Repair = { schema: JsonSchemaType; issue?: Exclude<Issue, "schema_validation_unavailable"> };

const singleSchemas = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
const schemaLists = ["allOf", "anyOf", "items", "oneOf", "prefixItems"];
const schemaMaps = [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
];

function isSchemaObject(value: unknown): value is JsonSchemaType {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

// These legacy identity escapes denote the same literal without the backslash.
const identityPunctuation = " !\"#%&',/:;<=>@_`~";

function repairPattern(pattern: string): string | undefined {
  let repaired = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "\\" && index + 1 < pattern.length) {
      const escaped = pattern.charAt(++index);
      const literal = identityPunctuation.includes(escaped) || (escaped === "-" && !inClass);
      repaired += literal ? escaped : `\\${escaped}`;
    } else {
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      repaired += char;
    }
  }
  return repaired !== pattern && validPattern(repaired) ? repaired : undefined;
}

function repairOutputSchema(schema: JsonSchemaType, depth = 0): Repair {
  if (depth >= 64) return { schema };
  const repaired: Record<string, unknown> = { ...schema };
  let issue: Repair["issue"];
  if (typeof schema.pattern === "string" && !validPattern(schema.pattern)) {
    const pattern = repairPattern(schema.pattern);
    if (pattern === undefined) {
      delete repaired.pattern;
      issue = "pattern_omitted";
    } else {
      repaired.pattern = pattern;
      issue = "pattern_repaired";
    }
  }

  const visit = (value: unknown): unknown => {
    if (!isSchemaObject(value)) return value;
    const child = repairOutputSchema(value, depth + 1);
    if (child.issue === "pattern_omitted" || !issue) issue = child.issue;
    return child.schema;
  };
  const keywords: Record<string, unknown> = schema;
  for (const key of singleSchemas) {
    if (isSchemaObject(keywords[key])) repaired[key] = visit(keywords[key]);
  }
  for (const key of schemaLists) {
    const list = keywords[key];
    if (Array.isArray(list)) repaired[key] = list.map(visit);
  }
  for (const key of schemaMaps) {
    const map = keywords[key];
    if (isSchemaObject(map)) {
      repaired[key] = Object.fromEntries(
        Object.entries(map).map(([name, value]) => [name, visit(value)]),
      );
    }
  }
  return { schema: issue ? (repaired as JsonSchemaType) : schema, issue };
}

class OutputSchemaValidator extends AjvJsonSchemaValidator {
  readonly issues = new WeakMap<JsonSchemaType, Issue>();

  override getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    try {
      return super.getValidator<T>(schema);
    } catch {
      const repaired = repairOutputSchema(schema);
      if (repaired.issue) {
        try {
          // A failed compile can leave the original $id in the AJV instance.
          const validate = new AjvJsonSchemaValidator().getValidator<T>(repaired.schema);
          this.issues.set(schema, repaired.issue);
          return validate;
        } catch {
          // Preserve discovery even if the schema still cannot compile.
        }
      }
      this.issues.set(schema, "schema_validation_unavailable");
      return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
    }
  }
}

class OrkMcpClient extends Client {
  private readonly outputValidator: OutputSchemaValidator;
  private readonly serverName?: string;

  constructor(
    info: ConstructorParameters<typeof Client>[0],
    options?: ConstructorParameters<typeof Client>[1],
    serverName?: string,
  ) {
    const outputValidator = new OutputSchemaValidator();
    super(info, { ...options, jsonSchemaValidator: outputValidator });
    this.outputValidator = outputValidator;
    this.serverName = serverName;
  }

  override async listTools(
    ...args: Parameters<Client["listTools"]>
  ): ReturnType<Client["listTools"]> {
    const result = await super.listTools(...args);
    for (const tool of result.tools) {
      const issue = tool.outputSchema && this.outputValidator.issues.get(tool.outputSchema);
      if (issue) {
        getLogger().warn("mcp.output_schema_adjusted", {
          "mcp.server": redactSensitiveText(
            this.serverName ?? this.getServerVersion()?.name ?? "unknown",
          ).slice(0, 200),
          "mcp.tool": redactSensitiveText(tool.name).slice(0, 200),
          reason: issue,
        });
      }
    }
    return result;
  }
}

export function createMcpClient(
  info: ConstructorParameters<typeof Client>[0],
  options?: ConstructorParameters<typeof Client>[1],
  serverName?: string,
): Client {
  return new OrkMcpClient(info, options, serverName);
}
