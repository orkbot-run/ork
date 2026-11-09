// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { createServerUpdates, ServerUpdatesView } from "@orkbot/core";
import { serverUpdateCanApply } from "@orkbot/core";
import { Button, OptionSelect, Switch } from "@orkbot/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

export function ServerUpdateSection({
  updates,
  state,
}: {
  updates: ReturnType<typeof createServerUpdates>;
  state: ServerUpdatesView;
}) {
  const { t } = useLingui();
  const status = state.status;
  const [serverVersion, setServerVersion] = useState<{
    revision: string | null;
    version: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void rpc.serverUpdates.version().then(
      (value) => {
        if (active) setServerVersion(value);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, []);
  const currentRevision = status?.currentRevision ?? serverVersion?.revision;
  if (!status?.available && !currentRevision && !serverVersion?.version) return null;
  const request = status?.lastRequest?.state;
  return (
    <SettingsGroup title={<Trans>Server</Trans>} data-testid="server-update-settings">
      <SettingsRow
        label={
          serverVersion?.version
            ? `v${serverVersion.version}${currentRevision ? ` (${currentRevision.slice(0, 12)})` : ""}`
            : (currentRevision?.slice(0, 12) ?? <Trans>Server</Trans>)
        }
        control={
          status?.available ? (
            <>
              <Button
                variant="outline"
                disabled={Boolean(state.busy)}
                onClick={() => void updates.check()}
              >
                <Trans>Check for updates</Trans>
              </Button>
              {status.candidate ? (
                <Button
                  disabled={!serverUpdateCanApply(state)}
                  onClick={() => void updates.apply()}
                >
                  <Trans>Update server</Trans>
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {status?.candidate && status.available ? (
          <p className="text-sm text-muted-foreground">{status.candidate.version}</p>
        ) : null}
        {status?.channel === "preview" && status.available && !status.channelSelectable ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Preview</Trans>
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {state.uncertain || request === "unknown" ? (
            <Trans>Could not confirm the update</Trans>
          ) : request === "completed" ? (
            <Trans>Server updated</Trans>
          ) : request === "requested" ? (
            <Trans>Deployment requested</Trans>
          ) : state.error || status?.error ? (
            <Trans>Could not complete the update. Try again.</Trans>
          ) : null}
        </p>
      </SettingsRow>
      {status?.available && status.channelSelectable ? (
        <SettingsRow
          label={<Trans>Update channel</Trans>}
          control={
            <OptionSelect
              aria-label={t`Update channel`}
              className="w-auto min-w-28"
              value={status.channel === "preview" ? "preview" : "stable"}
              options={[
                { value: "stable", label: t`Stable` },
                { value: "preview", label: t`Beta` },
              ]}
              disabled={Boolean(state.busy)}
              onValueChange={(channel) => void updates.channel(channel)}
            />
          }
        />
      ) : null}
      {status?.available ? (
        <SettingsRow
          label={<Trans>Automatic updates</Trans>}
          control={
            <Switch
              aria-label={t`Automatic updates`}
              checked={status.mode === "automatic"}
              disabled={Boolean(state.busy)}
              onCheckedChange={(enabled) => void updates.policy(enabled)}
            />
          }
        />
      ) : null}
    </SettingsGroup>
  );
}
