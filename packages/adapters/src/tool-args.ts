// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ZodError } from "zod";

/** Give the model a short correction for each invalid field, without a schema dump. */
export function argsError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
    .join("\n");
}
