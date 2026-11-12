// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IdentityCatalog } from "@orkbot/contracts";
import { View } from "react-native";
import type { AccountServer } from "../lib/account-servers";
import { displayApiHost } from "../lib/endpoint";
import { useI18n } from "../lib/i18n";
import { MenuPickerMenu } from "./menu-picker";
import { SettingsGroup, SettingsRow } from "./settings-group";

type Organization = IdentityCatalog["organizations"][number];
export function workspaceEntries(organization: Organization, entries: AccountServer[]) {
  const ids = new Set(
    organization.servers.flatMap((server) => server.workspaces.map((workspace) => workspace.id)),
  );
  return entries.filter((entry) => ids.has(entry.id));
}

export function WorkspaceDirectory({
  catalog,
  entries,
  organizationId,
  pending,
  onOrganization,
  onDefault,
  onSelect,
}: {
  catalog: IdentityCatalog;
  entries: AccountServer[];
  organizationId: string | null;
  pending: boolean;
  onOrganization(id: string): void;
  onDefault(id: string): void;
  onSelect(entry: AccountServer): void;
}) {
  const { t } = useI18n();
  const organization = catalog.organizations.find((row) => row.id === organizationId);
  return (
    <View style={{ gap: 16 }}>
      <SettingsGroup>
        <MenuPickerMenu
          label={t("Organization")}
          choices={catalog.organizations.map((row) => ({ key: row.id, label: row.name }))}
          value={organizationId ?? ""}
          disabled={pending}
          onChange={onOrganization}
        >
          <View>
            <SettingsRow
              title={t("Organization")}
              value={organization?.name ?? t("Choose organization")}
              chevron="down"
            />
          </View>
        </MenuPickerMenu>
        {organization ? (
          <SettingsRow
            title={
              catalog.defaultOrganizationId === organization.id
                ? t("Default organization")
                : t("Set as default organization")
            }
            disabled={pending || catalog.defaultOrganizationId === organization.id}
            onPress={() => onDefault(organization.id)}
          />
        ) : null}
      </SettingsGroup>
      {organization?.servers.map((server) => (
        <SettingsGroup key={server.id} label={server.name}>
          {server.workspaces.map((workspace) => {
            const entry = entries.find(
              (row) =>
                row.id === workspace.id && (!row.workspace || row.workspace.serverId === server.id),
            );
            const available =
              !!entry &&
              workspace.canOpen &&
              workspace.state === "ready" &&
              server.state === "ready";
            return (
              <SettingsRow
                key={workspace.id}
                title={workspace.name || (entry ? displayApiHost(entry.url) : t("Workspace"))}
                value={
                  server.state === "update-required"
                    ? t("Update server")
                    : workspace.state === "provisioning"
                      ? t("Preparing workspace")
                      : !workspace.canOpen
                        ? t("Access required")
                        : !entry
                          ? t("Server unavailable")
                          : undefined
                }
                disabled={pending || !available}
                onPress={available ? () => onSelect(entry!) : undefined}
                chevron={available ? "right" : undefined}
              />
            );
          })}
          {!server.workspaces.length ? (
            <SettingsRow title={t("No available workspaces")} disabled />
          ) : null}
        </SettingsGroup>
      ))}
      {organization && !organization.servers.length ? (
        <SettingsGroup>
          <SettingsRow title={t("No servers connected")} disabled />
        </SettingsGroup>
      ) : null}
    </View>
  );
}
