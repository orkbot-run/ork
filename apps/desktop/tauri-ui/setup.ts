// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Account = { userinfo: { name?: string; email?: string } };
type Server = { id: string; url: string; kind: "local" | "selfhosted"; deviceId: string | null };
type StackState = { phase: string; message: string | null; output: string[] };

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Setup element missing: ${id}`);
  return found as T;
}

const form = element<HTMLFormElement>("setup");
const input = element<HTMLInputElement>("server-url");
const status = element<HTMLParagraphElement>("status");
const connect = element<HTMLButtonElement>("connect");
const existing = element("existing-server");
const details = element<HTMLDetailsElement>("details");
const output = element("output");
const signedOut = element("signed-out");
const signedIn = element("signed-in");
const signIn = element<HTMLButtonElement>("sign-in");
const signOut = element<HTMLButtonElement>("sign-out");
const refresh = element<HTMLButtonElement>("refresh");
const servers = element("servers");
const addServer = element<HTMLDetailsElement>("add-server");
const modes = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
let generation = 0;
let account: Account | null = null;
let busy = false;

const selectedMode = () => Array.from(modes).find((mode) => mode.checked)?.value ?? "existing";
const syncMode = () => {
  const local = selectedMode() === "new";
  existing.hidden = local;
  input.required = !local;
  connect.textContent = local ? "Start server" : "Connect";
  details.hidden = true;
};
for (const mode of modes) mode.addEventListener("change", syncMode);

function setBusy(value: boolean) {
  busy = value;
  signIn.disabled = value;
  input.disabled = value;
  connect.disabled = value || !account;
  refresh.disabled = value || !account;
  for (const mode of modes) mode.disabled = value;
  for (const button of servers.querySelectorAll("button")) button.disabled = value;
}

function showAccount(value: Account | null) {
  account = value;
  signedOut.hidden = value !== null;
  signedIn.hidden = value === null;
  element("account").textContent = value?.userinfo.name ?? value?.userinfo.email ?? "Accounts";
  if (!value) {
    servers.replaceChildren();
    input.value = "";
    output.textContent = "";
    details.hidden = true;
  }
}

function message(error: unknown) {
  status.textContent =
    typeof error === "string" ? error : "Could not complete that request. Try again.";
}

async function run(operation: () => Promise<void>) {
  if (busy) return;
  const current = generation;
  setBusy(true);
  status.textContent = "";
  try {
    await operation();
  } catch (error) {
    if (current === generation) message(error);
  } finally {
    if (current === generation) setBusy(false);
  }
}

async function loadServers() {
  const current = generation;
  const entries = await invoke<Server[]>("list_servers");
  if (current !== generation) return;
  servers.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "server-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "button button-secondary server-open";
    open.textContent = entry.kind === "local" ? "This computer" : entry.url;
    open.addEventListener(
      "click",
      () =>
        void run(async () => {
          await invoke("connect_saved_server", { id: entry.id });
        }),
    );
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${open.textContent}`);
    remove.addEventListener(
      "click",
      () =>
        void run(async () => {
          await invoke("remove_server", { id: entry.id });
          if (current === generation) await loadServers();
        }),
    );
    row.append(open, remove);
    servers.append(row);
  }
  addServer.open = entries.length === 0;
}

const phaseLabels: Record<string, string> = {
  "checking-docker": "Checking Docker...",
  preparing: "Preparing server...",
  pulling: "Downloading server...",
  starting: "Starting server...",
  "waiting-healthy": "Waiting for server...",
  ready: "Server is ready.",
};

signIn.addEventListener(
  "click",
  () =>
    void run(async () => {
      const current = generation;
      const value = await invoke<Account>("setup_accounts_sign_in");
      if (current !== generation) return;
      showAccount(value);
      await loadServers();
    }),
);

signOut.addEventListener("click", async () => {
  generation++;
  showAccount(null);
  setBusy(true);
  signOut.disabled = true;
  status.textContent = "";
  try {
    await invoke("setup_accounts_logout");
  } catch (error) {
    message(error);
  } finally {
    signOut.disabled = false;
    setBusy(false);
  }
});
refresh.addEventListener("click", () => void run(loadServers));
element("quit").addEventListener("click", () => void invoke("quit_setup"));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void run(async () => {
    if (!account) return;
    const current = generation;
    if (selectedMode() === "new") await invoke("connect_local_server");
    else await invoke("connect_server", { rawUrl: input.value });
    if (current === generation) await loadServers();
  });
});

syncMode();
void run(async () => {
  await listen<StackState>("desktop-stack-changed", (event) => {
    if (!account || !busy) return;
    status.textContent = event.payload.message ?? phaseLabels[event.payload.phase] ?? "";
    output.textContent = event.payload.output.join("\n");
    details.hidden = event.payload.output.length === 0;
  });
  const value = await invoke<Account | null>("setup_accounts_session");
  showAccount(value);
  if (value) await loadServers();
});
