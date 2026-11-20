import { jsonrepair } from "jsonrepair";
import type { z } from "zod";

/**
 * Models wrap JSON in prose or fences and break its syntax; repair it before checking the shape.
 * A reply cut off before its closing brace is rejected, so repair never completes a verdict.
 */
export function parseModelJson<T extends z.ZodType>(
  text: string,
  schema: T,
): z.infer<T> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  const candidate = text.slice(start, end + 1);
  try {
    const result = schema.safeParse(JSON.parse(jsonrepair(candidate)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
