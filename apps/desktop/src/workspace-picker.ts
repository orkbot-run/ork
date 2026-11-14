// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IdentityCatalog } from "@orkbot/contracts";
import { catalogWorkspace } from "@orkbot/contracts";

export type DesktopWorkspace = { id: string; name: string; url: string };

/** Native IPC has already removed local routes belonging to other devices. */
export function desktopWorkspaceRoute(
  routes: IdentityCatalog["organizations"][number]["servers"][number]["routes"],
) {
  return (
    routes.find((row) => row.kind === "local" && row.deviceId !== null) ??
    routes.find((row) => row.kind === "direct" && row.deviceId === null) ??
    routes.find((row) => row.kind === "tunnel" && row.deviceId === null)
  );
}

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
  const field = doc.createElement("div");
  field.className = "organization-field";
  field.dataset.directoryGroup = "organization";
  const label = doc.createElement("span");
  label.className = "field-label";
  label.id = "organization-label";
  label.textContent = t("Organization");
  const picker = doc.createElement("button");
  picker.type = "button";
  picker.className = "field organization-trigger";
  picker.dataset.directoryControl = "true";
  picker.setAttribute("aria-haspopup", "listbox");
  picker.setAttribute("aria-expanded", "false");
  picker.setAttribute("aria-controls", "organization-options");
  picker.setAttribute("aria-label", t("Choose organization"));
  const organization = catalog.organizations.find((row) => row.id === organizationId);
  picker.textContent =
    organization?.name ?? t(organizationId ? "Organization unavailable" : "Choose organization");
  const list = doc.createElement("div");
  list.id = "organization-options";
  list.className = "organization-options";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-labelledby", label.id);
  list.hidden = true;
  const choices: HTMLButtonElement[] = [];
  function close(restoreFocus = false) {
    list.hidden = true;
    picker.setAttribute("aria-expanded", "false");
    if (restoreFocus) picker.focus();
  }
  function open(last = false) {
    if (picker.disabled || !choices.length) return;
    list.hidden = false;
    picker.setAttribute("aria-expanded", "true");
    const selected = choices.find((choice) => choice.getAttribute("aria-selected") === "true");
    (selected ?? choices[last ? choices.length - 1 : 0])?.focus();
  }
  picker.addEventListener("click", () => (list.hidden ? open() : close()));
  picker.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(event.key === "ArrowUp");
    }
  });
  for (const row of catalog.organizations) {
    const choice = doc.createElement("button");
    choice.type = "button";
    choice.className = "organization-option";
    choice.setAttribute("role", "option");
    choice.setAttribute("aria-selected", String(row.id === organizationId));
    choice.tabIndex = -1;
    choice.textContent = row.name;
    choice.addEventListener("click", () => {
      close();
      options.chooseOrganization(row.id);
      // Choosing an organization replaces the picker synchronously.
      container.querySelector<HTMLButtonElement>(".organization-trigger")?.focus();
    });
    choices.push(choice);
    list.append(choice);
  }
  list.addEventListener("keydown", (event) => {
    const index = choices.indexOf(doc.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % choices.length
            : event.key === "ArrowUp"
              ? (index - 1 + choices.length) % choices.length
              : null;
    if (next !== null) {
      event.preventDefault();
      choices[next]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    }
  });
  field.addEventListener("focusout", (event) => {
    if (!field.contains(event.relatedTarget as Node | null)) close();
  });
  field.append(label, picker, list);
  container.append(field);
  const entries: DesktopWorkspace[] = [];
  if (!organization) return entries;
  if (!organization.servers.length) {
    const empty = doc.createElement("p");
    empty.className = "hint";
    empty.dataset.directoryGroup = "servers";
    empty.textContent = t("No servers connected");
    container.append(empty);
  }
  for (const server of organization.servers) {
    const heading = doc.createElement("h3");
    heading.textContent = server.name;
    heading.dataset.directoryGroup = "servers";
    container.append(heading);
    for (const workspace of server.workspaces) {
      const choice = catalogWorkspace(catalog, {
        organizationId: organization.id,
        serverId: server.id,
        workspaceId: workspace.id,
      });
      const route = choice && desktopWorkspaceRoute(choice.server.routes);
      const entry =
        choice && route ? { id: workspace.id, name: workspace.name, url: route.address } : null;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "choice workspace-choice";
      button.dataset.directoryGroup = "servers";
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
    preferred.dataset.directoryGroup = "organization";
    preferred.textContent = t("Set as default organization");
    preferred.addEventListener("click", () => options.setDefaultOrganization(organization.id));
    container.append(preferred);
  }
  return entries;
}
