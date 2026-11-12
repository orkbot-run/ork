// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IdentityCatalog } from "@orkbot/contracts";
import { catalogWorkspace } from "@orkbot/contracts";

export type DesktopWorkspace = { id: string; name: string; url: string };

/** Present the complete catalog, including organizations and resources that cannot open yet. */
export function renderWorkspacePicker(options: {
  document: Document;
  container: HTMLElement;
  catalog: IdentityCatalog;
  organizationId: string | null;
  t(message: string): string;
  chooseOrganization(id: string | null): void;
  setDefaultOrganization(id: string): void;
  open(id: string): void;
}): DesktopWorkspace[] {
  const { document: doc, container, catalog, organizationId, t } = options;
  container.replaceChildren();
  const label = doc.createElement("label");
  label.className = "field-label";
  label.textContent = t("Organization");
  const picker = doc.createElement("select");
  picker.className = "field";
  picker.dataset.directoryControl = "true";
  picker.setAttribute("aria-label", t("Choose organization"));
  const placeholder = doc.createElement("option");
  placeholder.value = "";
  placeholder.textContent = t("Choose organization");
  picker.append(placeholder);
  for (const organization of catalog.organizations) {
    const option = doc.createElement("option");
    option.value = organization.id;
    option.textContent = organization.name;
    picker.append(option);
  }
  const organization = catalog.organizations.find((row) => row.id === organizationId);
  if (organizationId && !organization) {
    const unavailable = doc.createElement("option");
    unavailable.value = organizationId;
    unavailable.textContent = t("Organization unavailable");
    picker.append(unavailable);
  }
  picker.value = organizationId ?? "";
  picker.addEventListener("change", () => options.chooseOrganization(picker.value || null));
  label.append(picker);
  container.append(label);
  const entries: DesktopWorkspace[] = [];
  if (!organization) return entries;
  if (!organization.servers.length) {
    const empty = doc.createElement("p");
    empty.className = "hint";
    empty.textContent = t("No servers connected");
    container.append(empty);
  }
  for (const server of organization.servers) {
    const heading = doc.createElement("h3");
    heading.textContent = server.name;
    container.append(heading);
    for (const workspace of server.workspaces) {
      const choice = catalogWorkspace(catalog, {
        organizationId: organization.id,
        serverId: server.id,
        workspaceId: workspace.id,
      });
      const route = choice?.server.routes.find(
        (row) => row.kind === "direct" && row.deviceId === null,
      );
      const entry =
        choice && route ? { id: workspace.id, name: workspace.name, url: route.address } : null;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "choice workspace-choice";
      const text = doc.createElement("span");
      const name = doc.createElement("strong");
      name.textContent = workspace.name;
      const status = doc.createElement("small");
      if (entry) {
        entries.push(entry);
        status.className = "workspace-availability";
        status.dataset.workspaceId = workspace.id;
        button.addEventListener("click", () => options.open(workspace.id));
      } else {
        button.disabled = true;
        button.dataset.unavailable = "true";
        status.textContent = t(
          workspace.state === "provisioning"
            ? "Preparing workspace"
            : !workspace.canOpen
              ? "Access required"
              : "Server unavailable",
        );
      }
      text.append(name, status);
      button.append(text);
      container.append(button);
    }
  }
  if (catalog.defaultOrganizationId !== organization.id) {
    const preferred = doc.createElement("button");
    preferred.type = "button";
    preferred.className = "link";
    preferred.textContent = t("Set as default organization");
    preferred.addEventListener("click", () => options.setDefaultOrganization(organization.id));
    container.append(preferred);
  }
  return entries;
}
