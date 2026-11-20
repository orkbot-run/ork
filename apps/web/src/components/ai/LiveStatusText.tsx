// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { cn } from "@orkbot/ui-web";

export function LiveStatusText({ text, className }: { text: string; className?: string }) {
  return (
    <span
      key={text}
      dir="auto"
      className={cn(
        "block min-w-0 truncate motion-safe:transition-opacity motion-safe:duration-150 motion-safe:starting:opacity-0",
        className,
      )}
    >
      <span className="text-shimmer">{text}</span>
    </span>
  );
}
