// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 tests are preserved. Auth isolation and onboarding recovery follow LICENSE.md.

import type { Bot } from "@orkbot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ generation: 1, load: (_me: unknown) => {} }));

// The router has already authenticated this page; model setup must not start a real auth transport.
vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({ data: { user: { email: "member@example.test" } } }),
  },
}));

vi.mock("../lib/rpc", () => {
  const rpc = {
    me: vi.fn(
      () =>
        new Promise((resolve) => {
          account.load = resolve;
        }),
    ),
    onboarding: {
      ensureFirstBot: vi.fn(async () => null),
      start: vi.fn(),
      promptFocus: vi.fn(),
    },
    models: {
      connect: vi.fn(async () => ({ id: "fixture-credential" })),
      list: vi.fn(async () => [
        {
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          id: "",
          label: "Custom",
          billing: "API key",
        },
      ]),
      probeOpenAiCompatible: vi.fn(async () => ({
        models: Array.from({ length: 11 }, (_, index) => `found-${index}`),
      })),
    },
  };
  return {
    rpc,
    selectedSpaceId: () => null,
    captureRpcContext: () => {
      const generation = account.generation;
      return { client: rpc, isCurrent: () => generation === account.generation };
    },
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});

import { rpc } from "../lib/rpc";
import { OnboardingPage } from "./Onboarding";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  account.generation = 1;
  vi.mocked(rpc.models.connect).mockClear();
  vi.mocked(rpc.onboarding.ensureFirstBot).mockReset().mockResolvedValue(null);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("opens the app when setup is complete and the space needs no personal Ork", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app" element={<div data-testid="empty-space" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector('[data-testid="empty-space"]')).not.toBeNull();
  expect(rpc.onboarding.ensureFirstBot).toHaveBeenCalledOnce();
  expect(rpc.onboarding.start).not.toHaveBeenCalled();
});

it("keeps real provisioning failures visible during onboarding", async () => {
  vi.mocked(rpc.onboarding.ensureFirstBot).mockRejectedValue(new Error("Setup unavailable"));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app" element={<div data-testid="empty-space" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector('[data-testid="empty-space"]')).toBeNull();
  expect(host.textContent).toContain("Setup unavailable");
});

it.each([null, { id: "late-bot" } as Bot])(
  "ignores a provisioning result after leaving onboarding: %j",
  async (result) => {
    let resolve!: (bot: Bot | null) => void;
    vi.mocked(rpc.onboarding.ensureFirstBot).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/onboarding"]}>
          <Link to="/app/chosen">Open chosen chat</Link>
          <Routes>
            <Route path="/onboarding/:step?" element={<OnboardingPage />} />
            <Route path="/app/chosen" element={<div data-testid="chosen-chat" />} />
            <Route path="/app" element={<div data-testid="empty-space" />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      account.load({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
    );
    await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
    await act(async () => resolve(result));
    expect(host.querySelector('[data-testid="chosen-chat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="empty-space"]')).toBeNull();
    expect(rpc.onboarding.start).not.toHaveBeenCalled();
  },
);

it("marks onboarding as usable for the desktop only once a step shows", async () => {
  const subscribe = vi.spyOn(window, "addEventListener");
  // The shell sends a new account to /onboarding, which loads before it picks a step.
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  const marked = () => host.querySelector('[data-orkbot-surface="onboarding"]');
  expect(marked()).toBeNull();

  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  expect(subscribe).not.toHaveBeenCalledWith("storage", expect.any(Function));
});

it("finds and searches a long custom endpoint list during onboarding", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI-compatible")!
      .click(),
  );
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("OpenAI-compatible server URL", "https://models.example.test/v1");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
  );
  await change("Search models", "found-10");
  expect([...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent)).toEqual([
    "found-10",
    "Other model…",
  ]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(document.querySelector('[aria-label="Models from server"]')?.textContent).toBe("found-10");
});

it("does not create or navigate from readiness resolved for a previous account scope", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app" element={<div data-testid="wrong-navigation" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  account.generation++;
  await act(async () =>
    account.load({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(rpc.onboarding.ensureFirstBot).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="wrong-navigation"]')).toBeNull();
});

it("uses the selected standard protocol for discovery and save, then rechecks authoritative readiness", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app" element={<div data-testid="ready-app" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI-compatible")!
      .click(),
  );
  const change = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
    await act(async () => {
      const proto =
        element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
      );
    });
  };
  await change(
    document.querySelector<HTMLInputElement>('[aria-label="OpenAI-compatible server URL"]')!,
    "https://models.example.test/v1",
  );
  await change(document.querySelector<HTMLSelectElement>("select")!, "responses");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  expect(rpc.models.probeOpenAiCompatible).toHaveBeenLastCalledWith(
    expect.objectContaining({ apiProtocol: "responses" }),
  );
  vi.mocked(rpc.me).mockResolvedValueOnce({ needsModel: false, needsSignupSurvey: false } as never);
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Continue")!
      .click(),
  );
  expect(rpc.models.connect).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      apiProtocol: "responses",
      provider: "openai-compatible",
      modelId: "found-0",
      makeDefault: true,
      scope: "account",
    }),
  );
  expect(host.querySelector('[data-testid="ready-app"]')).not.toBeNull();
});

it("offers only protocol-supported effort and clamps the selected effort when protocols change", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding/model"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI-compatible")!
      .click(),
  );
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Advanced")!
      .click(),
  );
  await act(async () => document.querySelector<HTMLElement>('[role="checkbox"]')!.click());
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Reasoning effort"]')!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Extra high")!
      .click(),
  );
  const protocol = document.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      protocol,
      "anthropic-messages",
    );
    protocol.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector('[aria-label="Reasoning effort"]')?.textContent).toBe("High");
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Reasoning effort"]')!.click(),
  );
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.textContent,
  );
  expect(options).toContain("High");
  expect(options).not.toContain("Extra high");
  expect(options).not.toContain("Max");
});

it("uses the shared API-key readiness check instead of enabling an incomplete save", async () => {
  vi.mocked(rpc.models.list).mockResolvedValueOnce([
    {
      provider: "fixture-api",
      providerName: "Fixture API",
      id: "model",
      label: "Model",
      billing: "API key",
      auth: "api-key",
    },
  ]);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding/model"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Fixture API")!
      .click(),
  );
  const key = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  const update = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key, value);
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await update("x");
  expect(
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Continue")!
      .disabled,
  ).toBe(true);
  await update("fixture-key");
  expect(
    [...document.querySelectorAll("button")].find((button) => button.textContent === "Continue")!
      .disabled,
  ).toBe(false);
  expect(rpc.models.connect).not.toHaveBeenCalled();
});
