// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import type { PageVisibility } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";

/** Existing public links can be revoked even when a previous answer was lost. */
export function StopPageSharing({
  visibility,
  onStop,
  pending = false,
  error = null,
}: {
  visibility: PageVisibility | null;
  onStop: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  if (visibility === "private") return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" disabled={pending} onClick={onStop}>
        <Trans>Stop sharing</Trans>
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
