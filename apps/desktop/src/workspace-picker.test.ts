// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { IdentityCatalog } from "@orkbot/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { renderWorkspacePicker } from "./workspace-picker.js";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function catalog(): IdentityCatalog {
  return {
    version: 2,
    defaultOrganizationId: null,
    organizations: [
      { id: id(1), name: "Personal", type: "personal", role: "admin", servers: [] },
      {
        id: id(2),
        name: "Company",
        type: "shared",
        role: "admin",
        servers: [
          {
            id: id(3),
            name: "Research server",
            bindingVersion: 1,
            keyFingerprint: "a".repeat(64),
            state: "ready",
            routes: [
              { id: id(4), kind: "direct", address: "https://server.example.test", deviceId: null },
            ],
            workspaces: [
              { id: id(5), name: "Research", state: "ready", role: "member", canOpen: true },
              { id: id(6), name: "Restricted", state: "ready", role: null, canOpen: false },
              { id: id(7), name: "Preparing", state: "provisioning", role: null, canOpen: false },
            ],
          },
        ],
      },
    ],
  };
}
function render(value: IdentityCatalog, organizationId: string | null) {
  const container = document.createElement("div");
  document.body.append(container);
  const actions = { chooseOrganization: vi.fn(), setDefaultOrganization: vi.fn(), open: vi.fn() };
  const entries = renderWorkspacePicker({
    document,
    container,
    catalog: value,
    organizationId,
    t: (message) => message,
    ...actions,
  });
  return { container, entries, ...actions };
}
afterEach(() => {
  document.body.replaceChildren();
});

it("opens the local route retained by native device filtering", () => {
  const value = catalog();
  value.organizations[1]!.servers[0]!.routes.push({
    id: id(8),
    kind: "local",
    address: "http://127.0.0.1:45173",
    deviceId: id(9),
  });
  const { entries, container, open } = render(value, id(2));
  expect(entries[0]?.url).toBe("http://127.0.0.1:45173");
  container.querySelector<HTMLButtonElement>(".workspace-choice")!.click();
  expect(open).toHaveBeenCalledWith(id(5));
});

it("keeps organizations without servers in the chooser and waits for a choice", () => {
  const { container, entries, chooseOrganization, open } = render(catalog(), null);
  const select = container.querySelector("select")!;
  expect([...select.options].map((row) => row.textContent)).toEqual([
    "Choose organization",
    "Personal",
    "Company",
  ]);
  expect(entries).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  select.value = id(1);
  select.dispatchEvent(new Event("change"));
  expect(chooseOrganization).toHaveBeenCalledWith(id(1));
  const personal = render(catalog(), id(1));
  expect(personal.container.textContent).toContain("No servers connected");
  expect(personal.entries).toEqual([]);
});

it("does not turn organization administration into workspace access", () => {
  const { container, entries, open, setDefaultOrganization } = render(catalog(), id(2));
  expect(container.textContent).toContain("Research server");
  expect(entries.map((row) => row.id)).toEqual([id(5)]);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>(".workspace-choice")];
  expect(buttons.map((button) => button.disabled)).toEqual([false, true, true]);
  expect(buttons[1]!.textContent).toContain("Access required");
  expect(buttons[2]!.textContent).toContain("Preparing workspace");
  buttons[1]!.click();
  buttons[2]!.click();
  expect(open).not.toHaveBeenCalled();
  buttons[0]!.click();
  expect(open).toHaveBeenCalledWith(id(5));
  container.querySelector<HTMLButtonElement>(".link")!.click();
  expect(setDefaultOrganization).toHaveBeenCalledWith(id(2));
});

it("retains an unavailable explicit organization and never selects a different one", () => {
  const { container, entries, open } = render(catalog(), id(99));
  expect(container.querySelector("select")!.value).toBe(id(99));
  expect(container.textContent).toContain("Organization unavailable");
  expect(container.textContent).not.toContain("Research server");
  expect(entries).toEqual([]);
  expect(open).not.toHaveBeenCalled();
});

it("keeps an authorized workspace unavailable until the app supports its route", () => {
  const value = catalog();
  value.organizations[1]!.servers[0]!.routes[0]!.kind = "tunnel";
  const { container, entries, open } = render(value, id(2));
  expect(container.textContent).toContain("Server unavailable");
  expect(entries).toEqual([]);
  for (const button of container.querySelectorAll<HTMLButtonElement>(".workspace-choice"))
    button.click();
  expect(open).not.toHaveBeenCalled();
});
