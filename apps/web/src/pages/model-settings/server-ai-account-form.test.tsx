// @vitest-environment jsdom
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ModelCatalogEntry } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import { ServerAIAccountForm } from "./server-ai-account-form";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

const xai: ModelCatalogEntry = {
  provider: "xai",
  providerName: "xAI",
  id: "grok-fixture",
  label: "Grok fixture",
  billing: "Fixture subscription",
  auth: "both",
  signIn: "device-code",
  oauthLabel: "Fixture SuperGrok subscription sign-in",
  authHint: "Fixture subscription or key",
  recommended: true,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let current: boolean;
const saved = vi.fn(async () => undefined);
const cancel = vi.fn();
const serverAI = {
  beginOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  finishOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
  submitOAuthCode: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reconnect: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  current = true;
  serverAI.beginOAuth.mockResolvedValue({
    loginId: "attempt",
    provider: "xai",
    mode: "device-code",
    verificationUri: "https://subscription.example/activate",
    userCode: "FIXTURE-CODE",
    expiresInSeconds: 600,
  });
  serverAI.completeOAuth.mockResolvedValue({ status: "ready" });
  serverAI.finishOAuth.mockResolvedValue({ id: "account" });
  serverAI.cancelOAuth.mockResolvedValue({ ok: true });
  serverAI.create.mockResolvedValue({ id: "account" });
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(catalog = [xai]) {
  await act(async () =>
    root.render(
      <ServerAIAccountForm
        catalog={catalog}
        client={{ serverAI } as unknown as RpcClient}
        isCurrent={() => current}
        onSaved={saved}
        onCancel={cancel}
      />,
    ),
  );
}
function control(label: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  expect(id, label).toBeTruthy();
  return document.getElementById(id!) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}
async function value(label: string, value: string) {
  const input = control(label);
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled, label).toBe(false);
  await act(async () => button!.click());
}

it("offers a catalog-labelled Grok subscription with a provider-local model before any API key is entered", async () => {
  await render();
  expect(control("Name").value).toBe("xAI");
  expect(control("Models (one per line)").value).toBe("grok-fixture");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await click(xai.oauthLabel!);
  expect(serverAI.beginOAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "xai",
      models: ["grok-fixture"],
      label: "xAI",
      codePage: true,
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(window.open).toHaveBeenCalledWith(
    "https://subscription.example/activate",
    "_blank",
    "noopener,noreferrer",
  );
  expect(serverAI.finishOAuth).toHaveBeenCalledOnce();
  expect(saved).toHaveBeenCalledOnce();
  expect(serverAI.create).not.toHaveBeenCalled();
});

it("retains the explicit API-key alternative without starting an OAuth attempt", async () => {
  await render();
  await value("Authentication", "key");
  await value("API key", "fake-non-secret-key");
  await click("Save");
  expect(serverAI.create).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: expect.objectContaining({
        provider: "xai",
        modelId: "grok-fixture",
        apiKey: "fake-non-secret-key",
      }),
    }),
    { signal: expect.any(AbortSignal) },
  );
  expect(serverAI.beginOAuth).not.toHaveBeenCalled();
});

it("shows the provider's device code and sign-in link while waiting, with cancellation owned by that attempt", async () => {
  serverAI.completeOAuth.mockImplementation(() => new Promise(() => undefined));
  await render();
  await click(xai.oauthLabel!);
  expect(host.textContent).toContain("FIXTURE-CODE");
  expect(host.querySelector("a")?.href).toBe("https://subscription.example/activate");
  expect(control("Name").disabled).toBe(true);
  expect(control("Authentication").disabled).toBe(true);
  expect(serverAI.finishOAuth).not.toHaveBeenCalled();
  await click("Cancel");
  expect(serverAI.cancelOAuth).toHaveBeenCalledWith({ loginId: "attempt" });
  expect(saved).not.toHaveBeenCalled();
});

it("keeps OAuth-only providers free of an API-key form", async () => {
  await render([
    {
      ...xai,
      provider: "openai-codex",
      providerName: "Codex fixture",
      id: "codex-fixture",
      auth: "oauth",
    },
  ]);
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).not.toContain("Save");
  await click(xai.oauthLabel!);
  expect(serverAI.beginOAuth).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "openai-codex", models: ["codex-fixture"] }),
    expect.anything(),
  );
});

it("resets credentials and selects only the newly chosen provider's known model", async () => {
  await render([
    xai,
    {
      ...xai,
      provider: "other",
      providerName: "Other fixture",
      id: "other-model",
      auth: "api-key",
      signIn: undefined,
      recommended: false,
    },
  ]);
  await value("Authentication", "key");
  await value("API key", "fake-non-secret-key");
  await value("Provider", "other");
  expect(control("API key").value).toBe("");
  expect(control("Models (one per line)").value).toBe("other-model");
  expect(host.textContent).not.toContain(xai.oauthLabel);
});

it("leaves a compatible placeholder model explicit instead of authorizing a sample ID", async () => {
  await render([
    {
      ...xai,
      provider: "openai-compatible",
      auth: "api-key",
      signIn: undefined,
      placeholder: true,
    },
  ]);
  expect(control("Models (one per line)").value).toBe("");
  expect(
    [...host.querySelectorAll("button")].find((button) => button.textContent === "Save")!.disabled,
  ).toBe(true);
});
