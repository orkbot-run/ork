// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Progress } from "@orkbot/ui-web";

export function UpdateProgress({ label, percent }: { label: string; percent?: number | null }) {
  const value =
    typeof percent === "number" && Number.isFinite(percent)
      ? Math.min(100, Math.max(0, percent))
      : null;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span role="status">{label}</span>
        {value !== null ? (
          <span aria-hidden="true" className="tabular-nums">
            {Math.round(value)}%
          </span>
        ) : null}
      </div>
      <Progress value={value} aria-label={label} />
    </div>
  );
}
