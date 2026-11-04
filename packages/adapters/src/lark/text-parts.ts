import type { Root } from "chat";

export interface LarkTextPart {
  text: string;
  literal: boolean;
}

type LarkRootData = NonNullable<Root["data"]> & {
  orkbotLarkParts?: LarkTextPart[];
};

export function setLarkTextParts(root: Root, parts: LarkTextPart[]): void {
  const data: LarkRootData = { ...root.data, orkbotLarkParts: parts };
  root.data = data;
}

export function getLarkTextParts(root: Root): LarkTextPart[] | undefined {
  const data = root.data as { orkbotLarkParts?: unknown } | undefined;
  const parts = data?.orkbotLarkParts;
  if (
    Array.isArray(parts) &&
    parts.every(
      (part): part is LarkTextPart =>
        part != null &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        typeof part.literal === "boolean",
    )
  ) {
    return parts;
  }
  return undefined;
}
