// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans } from "@lingui/react/macro";
import { Button } from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { captureRpcContext } from "../../lib/rpc";
import { ServerAISettings } from "../ServerAISettings";

export function ManagedModelSetup({
  saving,
  error,
  onContinue,
}: {
  saving: boolean;
  error: string | null;
  onContinue(): void;
}) {
  const queries = useSpaceQueries();
  const [owner] = useState(() => captureRpcContext());
  const status = useQuery({
    ...queries.serverAI.status.queryOptions(),
    queryFn: () => owner.client.serverAI.status(),
  });
  const permissions = status.data;
  return (
    <div className="grid gap-6">
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      {permissions && !permissions.canManageWorkspace ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Ask a workspace administrator to enable an AI account for this workspace.</Trans>
        </p>
      ) : permissions && !permissions.canManageServer && !permissions.connections.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Ask a server administrator to make an AI account available to this workspace.
          </Trans>
        </p>
      ) : null}
      <ServerAISettings embedded onClose={() => undefined} />
      {permissions?.available === false ? (
        <div className="grid gap-3">
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load model settings</Trans>
          </p>
          <Button variant="outline" onClick={() => void status.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        disabled={saving || status.isPending || status.isError || !permissions?.available}
        onClick={onContinue}
      >
        <Trans>Continue</Trans>
      </Button>
    </div>
  );
}
