// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { Trans } from "@lingui/react/macro";
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
}: {
  saving: boolean;
  error: string | null;
  onContinue(): void;
  onModeChanged(): void;
}) {
  const queries = useSpaceQueries();
  const [owner] = useState(() => captureRpcContext());
  const [choosing, setChoosing] = useState(false);
  const [choiceError, setChoiceError] = useState(false);
  const handledPersonal = useRef(false);
  const handledReady = useRef<string | null>(null);
  const status = useQuery({
    ...queries.serverAI.status.queryOptions(),
    queryFn: () => owner.client.serverAI.status(),
    refetchOnWindowFocus: "always",
    refetchInterval: (query) => {
      const current = query.state.data;
      return current?.modelSetupMode === "pending" ||
        (current?.modelSetupMode === "organization" && !current.canManageServer)
        ? 5_000
        : false;
    },
  });
  const permissions = status.data;
  useEffect(() => {
    if (permissions?.modelSetupMode === "personal" && !handledPersonal.current) {
      handledPersonal.current = true;
      onModeChanged();
    } else if (
      permissions?.modelSetupMode === "organization" &&
      !permissions.canManageServer &&
      !saving
    ) {
      const ready = permissions.connections.find(
        (row) => row.enabled && row.isDefault && row.state === "active" && row.defaultModelId,
      );
      const revision = ready && `${ready.id}:${ready.assignmentRevision}`;
      if (revision && handledReady.current !== revision) {
        handledReady.current = revision;
        onContinue();
      }
    }
  }, [permissions, saving, onModeChanged, onContinue]);
  async function choose(mode: "organization" | "personal") {
    if (choosing || !owner.isCurrent()) return;
    setChoosing(true);
    setChoiceError(false);
    try {
      await owner.client.serverAI.chooseMode({ mode });
      await status.refetch();
      if (owner.isCurrent()) onModeChanged();
    } catch {
      if (owner.isCurrent()) setChoiceError(true);
    } finally {
      if (owner.isCurrent()) setChoosing(false);
    }
  }
  return (
    <div className="grid gap-6">
      <h1 className="text-[32px] font-medium text-foreground">
        <Trans>Connect a model</Trans>
      </h1>
      {permissions?.modelSetupMode === "pending" ? (
        permissions.canManageServer ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              <Trans>Choose how people in your organization will connect models.</Trans>
            </p>
            <Button disabled={choosing} onClick={() => void choose("organization")}>
              <Trans>Connect organization models</Trans>
            </Button>
            <Button variant="outline" disabled={choosing} onClick={() => void choose("personal")}>
              <Trans>Let people connect their own models</Trans>
            </Button>
            <p className="text-sm text-muted-foreground">
              <Trans>Personal models may process workspace data outside company servers.</Trans>
            </p>
            {choiceError ? (
              <p role="alert">
                <Trans>Could not save. Try again.</Trans>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>Waiting for an organization administrator to set up models.</Trans>
          </p>
        )
      ) : permissions && !permissions.canManageServer ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Waiting for an organization administrator to set up models.</Trans>
        </p>
      ) : null}
      {permissions?.modelSetupMode !== "pending" ? (
        <ServerAISettings embedded onboarding onClose={() => undefined} />
      ) : null}
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
      {permissions?.modelSetupMode !== "pending" &&
      (permissions?.canManageServer || permissions?.modelSetupMode !== "organization") ? (
        <Button
          disabled={saving || status.isPending || status.isError || !permissions?.available}
          onClick={onContinue}
        >
          <Trans>Continue</Trans>
        </Button>
      ) : null}
    </div>
  );
}
