// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 code remains separately licensed. Generator-only avatar editing is an Ork addition.

import type { BotAvatarSet } from "@orkbot/contracts";
import { logoAvatarTraits } from "@orkbot/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateBotDialogInput } from "./create-bot-dialog";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { CreateBotDialog } from "./create-bot-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  onCreate: (input: CreateBotDialogInput) => Promise<void>,
  avatarSet: BotAvatarSet = "orkbot",
) {
  await act(async () => {
    root.render(
      <CreateBotDialog avatarSet={avatarSet} onCancel={() => undefined} onCreate={onCreate} />,
    );
  });
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("CreateBotDialog", () => {
  it("creates only once the name is not blank", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(onCreate);
    expect(button("Create").disabled).toBe(true);
    await typeName("   ");
    expect(button("Create").disabled).toBe(true);
    await typeName("  Scout  ");
    expect(button("Create").disabled).toBe(false);
  });

  it("offers only generated identities and leaves the set to the server", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector(".orkbot-organic-avatar")).toBeNull();
    expect(document.querySelectorAll('[aria-label^="Avatar "]')).toHaveLength(8);
    expect(document.querySelector('[aria-label="wedge"]')).toBeNull();
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({ name: "Scout" });
    expect(onCreate.mock.lastCall?.[0].id).toMatch(/^c[a-z0-9]{24}$/);
    expect(onCreate.mock.lastCall?.[0]).not.toHaveProperty("avatarSet");
    expect(onCreate.mock.lastCall?.[0]).not.toHaveProperty("avatarFamily");
  });

  it("sends the Ork preview id without an organic family", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate, "orkbot");
    await typeName("Scout");
    await click(button("Create"));
    const input = onCreate.mock.lastCall![0];
    const preview = document.querySelector(".orkbot-logo-avatar")!;
    expect(input).toMatchObject({ name: "Scout" });
    expect(input).not.toHaveProperty("avatarFamily");
    expect(input.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(input.color?.toUpperCase()).toBe(preview.getAttribute("data-color")?.toUpperCase());
  });

  it("preserves an explicitly chosen Ork colour through a failed create and retry", async () => {
    const onCreate = vi
      .fn(async (_input: CreateBotDialogInput) => undefined)
      .mockRejectedValueOnce(new Error("Try again"));
    await render(onCreate, "orkbot");
    await click(button("Color #00C972"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({ color: "#00C972" });
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({ color: "#00C972" });
  });

  it("keeps the submitted generator identity and color fixed after an uncertain create response", async () => {
    const onCreate = vi
      .fn(async (_input: CreateBotDialogInput) => undefined)
      .mockRejectedValueOnce(new Error("Response lost"));
    await render(onCreate);
    await click(button("Avatar 2"));
    await typeName("Scout");
    await click(button("Create"));
    const first = onCreate.mock.lastCall![0];
    expect(document.querySelector("fieldset")?.disabled).toBe(true);
    await click(button("Avatar 3"));
    await click(button("Color #00C972"));
    await click(button("Create"));
    expect(onCreate.mock.lastCall![0]).toMatchObject({ id: first.id, color: first.color });
  });

  it("persists the exact selected generator identity with an explicit color", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("Avatar 2"));
    await click(button("Color #00C972"));
    const preview = document.querySelector(".orkbot-logo-avatar")!;
    const appearance = Object.fromEntries(
      ["shape", "eyes", "mouth", "accessory"].map((key) => [
        key,
        preview.getAttribute(`data-${key}`),
      ]),
    );
    await typeName("Scout");
    await click(button("Create"));
    const input = onCreate.mock.lastCall![0];
    expect(input).toMatchObject({ name: "Scout", color: "#00C972" });
    expect(input).not.toHaveProperty("avatarFamily");
    expect(logoAvatarTraits(input.id!, input.color).appearance).toMatchObject(appearance);
  });

  it("shows the error and stays open when creating fails", async () => {
    await render(async () => {
      throw new Error("Bot limit reached");
    });
    await typeName("Scout");
    await click(button("Create"));
    expect(document.querySelector('[data-testid="create-bot-error"]')?.textContent).toBe(
      "Bot limit reached",
    );
    expect(document.querySelector('[data-testid="create-bot-dialog"]')).not.toBeNull();
  });
});

it("retains the preview identity and colour through rerenders and a retry", async () => {
  const onCreate = vi
    .fn(async (_input: CreateBotDialogInput) => undefined)
    .mockRejectedValueOnce(new Error("Try again"));
  await render(onCreate, "orkbot");
  const colour = document.querySelector(".orkbot-logo-avatar")!.getAttribute("data-color");
  await typeName("First name");
  await render(onCreate, "orkbot");
  expect(document.querySelector(".orkbot-logo-avatar")!.getAttribute("data-color")).toBe(colour);
  await click(button("Create"));
  const first = onCreate.mock.lastCall![0];
  await typeName("Retry name");
  await click(button("Create"));
  const second = onCreate.mock.lastCall![0];
  expect(first.id).toMatch(/^c[a-z0-9]{24}$/);
  expect(second.id).toBe(first.id);
  expect(second.color).toBe(first.color);
  expect(second.color?.toUpperCase()).toBe(colour?.toUpperCase());
});
