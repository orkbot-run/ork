// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0, me: vi.fn(), health: vi.fn(), status: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  captureRpcContext: () => {
    const generation = state.generation;
    return {
      client: { me: state.me, health: state.health, computer: { status: state.status } },
      isCurrent: () => generation === state.generation,
    };
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@orkbot/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  Spinner: () => <span>loading</span>,
}));
vi.mock("./ai/primitives", () => ({
  SuccessPop: ({ label }: { label: string }) => <span>{label}</span>,
}));

import { ComputersUnavailableHint } from "./ComputersUnavailableHint";

const unavailable = { start: false, screen: false, control: false, terminal: false };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.generation = 0;
  state.me.mockReset();
  state.status.mockReset();
  state.health.mockReset().mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps ordinary recovery free of operator environment instructions", async () => {
  await act(async () =>
    root.render(<ComputersUnavailableHint computerCapabilities={unavailable} />),
  );
  expect(host.textContent).toContain("Computers unavailable");
  expect(host.textContent).toContain("Check again");
  expect(host.textContent).not.toContain(".env");
  expect(host.textContent).not.toContain("SANDBOX_PROVIDER");
  expect(host.textContent).not.toContain("Open computer settings");
});

it.each(["resolve", "reject"] as const)(
  "ignores a late recovery %s after account/server/Space ownership changes",
  async (outcome) => {
    let finish!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    state.me.mockReturnValue(
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    );
    const recovered = vi.fn();
    await act(async () =>
      root.render(
        <ComputersUnavailableHint computerCapabilities={unavailable} onRecovered={recovered} />,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    state.generation++;
    await act(async () =>
      root.render(
        <ComputersUnavailableHint
          computerCapabilities={{ ...unavailable }}
          onRecovered={recovered}
        />,
      ),
    );
    await act(async () => {
      if (outcome === "resolve") finish({ computerCapabilities: { ...unavailable, start: true } });
      else fail(new Error("old scope failure"));
    });
    expect(recovered).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("old scope failure");
    expect(host.textContent).not.toContain("Computers are available");
    expect(host.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
  },
);

it("checks the selected bot target instead of treating an available Team default as recovery", async () => {
  const me = { computerCapabilities: { start: true, screen: true, control: true, terminal: true } };
  const computer = { botId: "dedicated", capabilities: unavailable };
  state.me.mockResolvedValue(me);
  state.status.mockResolvedValue(computer);
  const recovered = vi.fn();
  await act(async () =>
    root.render(
      <ComputersUnavailableHint
        botId="dedicated"
        computerCapabilities={unavailable}
        onRecovered={recovered}
      />,
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
  expect(state.status).toHaveBeenCalledWith({ botId: "dedicated" });
  expect(host.textContent).toContain("Computers unavailable");
  expect(host.textContent).not.toContain("Computers are available");
  expect(recovered).toHaveBeenCalledWith(me, computer);
});
