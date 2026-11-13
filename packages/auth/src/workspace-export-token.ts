// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ACCOUNT_EXPORT_TOKEN_MS } from "./account-export-token.js";

export const WORKSPACE_EXPORT_TOKEN_PREFIX = "workspace-export-v2-";
const scopeSchema = z
  .object({
    userId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    spaceId: z.string().min(1).max(200),
    workspaceId: z.uuid(),
    revision: z.uuid(),
  })
  .strict();
export type WorkspaceExportScope = z.infer<typeof scopeSchema>;
type Verification = { value: string; expiresAt: Date };

export async function issueWorkspaceExportToken(
  adapter: {
    createVerificationValue(data: Verification & { identifier: string }): Promise<unknown>;
  },
  scope: WorkspaceExportScope,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await adapter.createVerificationValue({
    identifier: WORKSPACE_EXPORT_TOKEN_PREFIX + token,
    value: JSON.stringify(scopeSchema.parse(scope)),
    expiresAt: new Date(Date.now() + ACCOUNT_EXPORT_TOKEN_MS),
  });
  return token;
}

export async function consumeWorkspaceExportToken(
  adapter: { consumeVerificationValue(identifier: string): Promise<Verification | null> },
  token: string,
): Promise<WorkspaceExportScope | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const stored = await adapter.consumeVerificationValue(WORKSPACE_EXPORT_TOKEN_PREFIX + token);
  if (!stored || stored.expiresAt.getTime() <= Date.now()) return null;
  try {
    return scopeSchema.parse(JSON.parse(stored.value));
  } catch {
    return null;
  }
}
