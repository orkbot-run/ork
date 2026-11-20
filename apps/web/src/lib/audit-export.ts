// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ORPCError } from "@orpc/client";
import { downloadBlob } from "./artifact-open";
import { recheckSessionOnUnauthorized, selectedSpaceId, withSpaceHeaders } from "./rpc";

export async function exportOrganizationAudit(
  spaceId: string | null,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/audit-events/export", {
    credentials: "include",
    headers: withSpaceHeaders({ Accept: "application/x-ndjson" }, spaceId),
    redirect: "error",
    signal,
  });
  recheckSessionOnUnauthorized(response.status);
  if (response.status === 403) throw new ORPCError("FORBIDDEN");
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";")[0] !== "application/x-ndjson"
  )
    throw new Error("Could not export the activity log");
  const name =
    response.headers
      .get("content-disposition")
      ?.match(/filename="(orkbot-audit-log-\d{4}-\d{2}-\d{2}\.jsonl)"/)?.[1] ??
    "orkbot-audit-log.jsonl";
  const blob = await response.blob();
  signal.throwIfAborted();
  if (selectedSpaceId() !== spaceId) throw new DOMException("Space changed", "AbortError");
  downloadBlob(name, blob);
}
