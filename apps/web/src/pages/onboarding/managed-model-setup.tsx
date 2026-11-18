// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans } from "@lingui/react/macro";
import { workspaceAIReady } from "@orkbot/core";
import { Button } from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { captureRpcContext } from "../../lib/rpc";
import { ServerAISettings } from "../ServerAISettings";

export function ManagedModelSetup({
  saving,
  error,
  onContinue,
  onModeChanged,
  onSkip,
}: {
  saving: boolean;
  error: string | null;
  onContinue(): void;
  onModeChanged(): void;
  onSkip(): void;
}) {
  const queries = useSpaceQueries();
  const [owner] = useState(() => captureRpcContext());
  const handledPersonal = useRef(false);
  const handledReady = useRef<string | null>(null);
  const status = useQuery({
    ...queries.serverAI.status.queryOptions(),
    queryFn: () => owner.client.serverAI.status(),
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => {
      const current = query.state.data;
      return current?.modelSetupMode === "pending" ||
        ((current?.modelSetupMode === "organization" || current?.modelSetupMode === "legacy") &&
          !current.canManageServer)
        ? 5_000
        : false;
    },
  });
  const permissions = status.data;
  useEffect(() => {
    if (permissions?.modelSetupMode === "personal") {
      if (!handledPersonal.current) {
        handledPersonal.current = true;
        onModeChanged();
      }
    } else if (permissions && permissions.modelSetupMode !== "pending" && !saving) {
      const ready = permissions.connections.find(workspaceAIReady);
      const revision = ready && `${ready.id}:${ready.assignmentRevision}`;
      if (revision && handledReady.current !== revision) {
        handledReady.current = revision;
        onContinue();
      }
    }
  }, [permissions, saving, onModeChanged, onContinue]);
  return (
    <div className="grid gap-6">
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      {permissions?.canManageServer ? (
        <>
          <ServerAISettings embedded onboarding onClose={() => undefined} />
          <Button type="button" variant="ghost" className="justify-self-start" onClick={onSkip}>
            <Trans>Skip for now</Trans>
          </Button>
        </>
      ) : permissions?.available ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Waiting for an organization administrator to set up models.</Trans>
        </p>
      ) : null}
      {status.isError || permissions?.available === false ? (
        <div className="grid gap-3">
          <p role="alert" className="text-sm text-destructive">
            <Trans>Could not load model settings</Trans>
          </p>
          <Button variant="outline" onClick={() => void status.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {permissions &&
      !permissions.canManageServer &&
      permissions.adminAccessReason === "role_unavailable" ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Your organization role could not be verified. Check that Accounts and this server are up
            to date.
          </Trans>
        </p>
      ) : null}
      {permissions &&
      !permissions.canManageServer &&
      permissions.adminAccessReason === "unverified" ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Administrator access could not be verified. Sign in again or check the server
            configuration.
          </Trans>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {error ? (
        <Button disabled={saving} onClick={onContinue}>
          <Trans>Retry</Trans>
        </Button>
      ) : null}
    </div>
  );
}
