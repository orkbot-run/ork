// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerProviderSettings } from "./ComputerProviderSettings";

vi.mock("@lingui/react/macro", () => {
  // Stable like Lingui's own, since the form reloads when it changes.
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@orkbot/ui-web", () => ({
  Button: ({ size: _size, ...props }: ComponentProps<"button"> & { size?: string }) => (
    <button {...props} />
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
}));
vi.mock("./ai/primitives", () => ({ SuccessPop: () => null }));
const { deployment, account, current, me } = vi.hoisted(() => ({
  current: { value: true },
  me: vi.fn(),
  deployment: { get: vi.fn(), update: vi.fn() },
  account: { get: vi.fn(), update: vi.fn() },
}));
// Like the real client, every property read returns a new object.
vi.mock("../lib/rpc", () => ({
  captureRpcContext: () => ({
    isCurrent: () => current.value,
    client: { me, computerProvider: { ...deployment, account } },
  }),
  rpc: {
    get computerProvider() {
      return {
        ...deployment,
        get account() {
          return { ...account };
        },
      };
    },
  },
}));

const saved = {
  provider: "personal-desktop",
  defaultProvider: "docker",
  providers: [
    {
      id: "personal-desktop",
      displayName: "Personal desktop",
      capabilities: { perAccount: true },
      fields: [
        { key: "desktop", label: "Desktop", kind: "text", required: true },
        { key: "url", label: "Gateway", kind: "url", required: true },
        { key: "token", label: "Token", kind: "secret", required: true, destination: "url" },
      ],
    },
  ],
  values: { desktop: "example-desktop", url: "https://gateway.example.com/mcp" },
  savedSecrets: { token: true },
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  current.value = true;
  me.mockResolvedValue({
    computerCapabilities: { start: true, screen: true, control: true, terminal: false },
    sandboxProvider: "deployment-target",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("saves an account's own desktop to the account, never the deployment", async () => {
  account.get.mockResolvedValue(saved);
  account.update.mockResolvedValue(saved);
  const onConfigurationChange = vi.fn();
  await act(async () =>
    root.render(
      <ComputerProviderSettings scope="account" onConfigurationChange={onConfigurationChange} />,
    ),
  );
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("example-desktop");
  // Loaded once, not again on every render.
  expect(account.get).toHaveBeenCalledOnce();

  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({
    provider: saved.provider,
    values: saved.values,
  });
  expect(deployment.get).not.toHaveBeenCalled();
  expect(deployment.update).not.toHaveBeenCalled();
  // Refresh authoritative account capability metadata without rewriting the deployment target.
  expect(onConfigurationChange).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxProvider: "deployment-target" }),
  );
});

it("sends an account back to the deployment default", async () => {
  account.get.mockResolvedValue({ ...saved, provider: "default", values: {}, savedSecrets: {} });
  account.update.mockResolvedValue({
    ...saved,
    provider: "default",
    values: {},
    savedSecrets: {},
  });
  const onConfigurationChange = vi.fn();
  await act(async () =>
    root.render(
      <ComputerProviderSettings scope="account" onConfigurationChange={onConfigurationChange} />,
    ),
  );
  expect(host.querySelector("input")).toBeNull();
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(account.update).toHaveBeenCalledWith({ provider: "default", values: {} });
  expect(onConfigurationChange).toHaveBeenCalledOnce();
});

/** Types into the field labelled `label` the way a person pasting would. */
function paste(label: string, text: string) {
  const id = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )?.htmlFor;
  const input = host.querySelector<HTMLInputElement>(`[id="${id}"]`);
  if (!input) throw new Error(`no ${label} field`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("requires credentials again after changing the destination", async () => {
  account.get.mockResolvedValue(saved);
  await act(async () => root.render(<ComputerProviderSettings scope="account" />));
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(false);
  await act(async () => paste("Gateway", "https://other.example.com/mcp"));
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.required).toBe(true);
});

it("hides the account form when no provider supports accounts", async () => {
  account.get.mockResolvedValue({ ...saved, providers: [] });
  await act(async () => root.render(<ComputerProviderSettings scope="account" />));
  expect(host.querySelector("form")).toBeNull();
});

it("blocks the fields while a save is in flight", async () => {
  account.get.mockResolvedValue(saved);
  let finishSave!: () => void;
  account.update.mockReturnValue(
    new Promise((resolve) => {
      finishSave = () => resolve(saved);
    }),
  );
  await act(async () => root.render(<ComputerProviderSettings scope="account" />));

  await act(async () => host.querySelector("form")?.requestSubmit());
  // The response replaces the draft, so an edit accepted meanwhile would be
  // silently lost while the form still claims "Saved".
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  expect(host.querySelector<HTMLSelectElement>("select")?.matches(":disabled")).toBe(true);

  finishSave();
  await act(async () => {});
  expect(host.querySelector("fieldset")?.disabled).toBe(false);
});

it("does not publish a completed save into a replacement session", async () => {
  account.get.mockResolvedValue(saved);
  let finish!: (value: typeof saved) => void;
  account.update.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const onConfigurationChange = vi.fn();
  await act(async () =>
    root.render(
      <ComputerProviderSettings scope="account" onConfigurationChange={onConfigurationChange} />,
    ),
  );
  await act(async () => host.querySelector("form")?.requestSubmit());
  current.value = false;
  await act(async () => finish(saved));
  expect(me).not.toHaveBeenCalled();
  expect(onConfigurationChange).not.toHaveBeenCalled();
});

it("does not report a late failed save in a replacement session", async () => {
  account.get.mockResolvedValue(saved);
  let fail!: (error: Error) => void;
  account.update.mockReturnValue(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  await act(async () => root.render(<ComputerProviderSettings scope="account" />));
  await act(async () => host.querySelector("form")?.requestSubmit());
  current.value = false;
  await act(async () => fail(new Error("old account failure")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
