// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { createServerUpdates, ServerUpdatesView } from "@orkbot/core";
import { serverUpdateCanApply } from "@orkbot/core";
import { Button, Switch } from "@orkbot/ui-web";
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
  if (!status?.available) return null;
  const request = status.lastRequest?.state;
  return (
    <SettingsGroup title={<Trans>Server</Trans>} data-testid="server-update-settings">
      <SettingsRow
        label={status.currentRevision?.slice(0, 12) ?? <Trans>Server</Trans>}
        control={
          <>
            <Button
              variant="outline"
              disabled={Boolean(state.busy)}
              onClick={() => void updates.check()}
            >
              <Trans>Check for updates</Trans>
            </Button>
            {status.candidate ? (
              <Button disabled={!serverUpdateCanApply(state)} onClick={() => void updates.apply()}>
                <Trans>Update server</Trans>
              </Button>
            ) : null}
          </>
        }
      >
        {status.candidate ? (
          <p className="text-sm text-muted-foreground">{status.candidate.version}</p>
        ) : null}
        {status.channel === "preview" ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Preview</Trans>
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {state.uncertain || request === "unknown" ? (
            <Trans>Check deployment in server panel</Trans>
          ) : request === "requested" ? (
            <Trans>Deployment requested</Trans>
          ) : state.error || status.error ? (
            <Trans>Could not complete the update. Try again.</Trans>
          ) : null}
        </p>
      </SettingsRow>
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
    </SettingsGroup>
  );
}
