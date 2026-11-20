// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited hover behavior is preserved; layout for narrow transcripts follows LICENSE.md.

import type { ReactNode } from "react";

export function MessageHoverMetadata({
  side,
  pinned = false,
  children,
}: {
  side: "start" | "end";
  pinned?: boolean;
  children: ReactNode;
}) {
  // Keep actions below the bubble on touch and when the transcript is too narrow for a side rail.
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : "pointer-events-auto opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100";

  return (
    <div
      data-testid="message-hover-rail"
      className={`absolute top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity ${reveal} ${
        side === "end" ? "start-full ms-1" : "end-full me-1"
      } @max-[30rem]/transcript:static @max-[30rem]/transcript:mt-1 @max-[30rem]/transcript:w-full @max-[30rem]/transcript:translate-y-0 [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:w-full [@media(hover:none)]:translate-y-0 ${
        side === "end"
          ? "@max-[30rem]/transcript:ms-0 @max-[30rem]/transcript:justify-start [@media(hover:none)]:ms-0 [@media(hover:none)]:justify-start"
          : "@max-[30rem]/transcript:me-0 @max-[30rem]/transcript:justify-end [@media(hover:none)]:me-0 [@media(hover:none)]:justify-end"
      }`}
    >
      {children}
    </div>
  );
}
