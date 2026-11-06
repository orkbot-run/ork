// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

declare const __ORKBOT_DEFAULT_SERVER__: string;

type StackState = {
  phase:
    | "idle"
    | "checking-docker"
    | "docker-missing"
    | "docker-not-running"
    | "preparing"
    | "pulling"
    | "starting"
    | "waiting-healthy"
    | "ready"
    | "failed";
  message: string | null;
  output: string[];
};

const form = document.querySelector<HTMLFormElement>("#setup");
const input = document.querySelector<HTMLInputElement>("#server-url");
const status = document.querySelector<HTMLParagraphElement>("#status");
const connect = document.querySelector<HTMLButtonElement>("#connect");
const quit = document.querySelector<HTMLButtonElement>("#quit");
const existing = document.querySelector<HTMLElement>("#existing-server");
const details = document.querySelector<HTMLDetailsElement>("#details");
const output = document.querySelector<HTMLElement>("#output");
const modes = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');

if (!form || !input || !status || !connect || !quit || !existing || !details || !output)
  throw new Error("Setup elements missing");

const selectedMode = () => Array.from(modes).find((mode) => mode.checked)?.value ?? "existing";
const syncMode = () => {
  const local = selectedMode() === "new";
  existing.hidden = local;
  input.required = !local;
  connect.textContent = local ? "Start server" : "Connect";
  status.textContent = "";
  details.hidden = true;
};
for (const mode of modes) mode.addEventListener("change", syncMode);

const phaseLabels: Partial<Record<StackState["phase"], string>> = {
  "checking-docker": "Checking Docker...",
  preparing: "Preparing server...",
  pulling: "Downloading server...",
  starting: "Starting server...",
  "waiting-healthy": "Waiting for server...",
  ready: "Server is ready.",
};
const showStack = (state: StackState) => {
  if (selectedMode() !== "new") return;
  status.textContent = state.message ?? phaseLabels[state.phase] ?? "";
  output.textContent = state.output.join("\n");
  details.hidden = state.output.length === 0;
};

input.value = __ORKBOT_DEFAULT_SERVER__;
Promise.all([
  invoke<{ serverUrl: string | null; mode: "existing" | "new" }>("setup_state"),
  listen<StackState>("desktop-stack-changed", (event) => showStack(event.payload)),
  listen<string>("desktop-reopen-failed", (event) => {
    status.textContent = event.payload;
  }),
]).then(
  async ([state]) => {
    input.value = state.serverUrl ?? input.value;
    for (const mode of modes) mode.checked = mode.value === state.mode;
    syncMode();
    if (state.mode === "new") showStack(await invoke<StackState>("local_stack_state"));
    connect.disabled = false;
  },
  () => {
    status.textContent = "Could not read the saved server.";
  },
);
quit.addEventListener("click", () => void invoke("quit_setup"));
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  input.disabled = true;
  connect.disabled = true;
  for (const mode of modes) mode.disabled = true;
  status.textContent = "";
  try {
    if (selectedMode() === "new") await invoke("connect_local_server");
    else await invoke("connect_server", { rawUrl: input.value });
  } catch (error) {
    status.textContent = typeof error === "string" ? error : "Could not connect to that server.";
  } finally {
    input.disabled = false;
    connect.disabled = false;
    for (const mode of modes) mode.disabled = false;
  }
});
