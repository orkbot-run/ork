// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0

// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; billing recovery changes follow LICENSE.md.

// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const { portal } = vi.hoisted(() => ({ portal: vi.fn().mockRejectedValue(new Error("offline")) }));

vi.mock("../lib/rpc", () => ({
  rpc: { billing: { portal } },
  rpcForSpace: () => ({ billing: {} }),
  createSpaceRpc: () => ({ billing: {} }),
  selectedSpaceId: () => null,
  clearSpaceSelection: () => undefined,
}));
vi.mock("../pages/Auth", () => ({
  AuthFrame: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  submitClass: "",
}));
vi.mock("./AccountMenu", () => ({
  AccountMenu: () => <div data-testid="account-menu" />,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.flatMap((part, index) => [part, values[index] ?? ""]).join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@orkbot/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  );
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button,
    Skeleton: (props: ComponentProps<"div">) => <div {...props} />,
    Card: Container,
    CardContent: Container,
    CardFooter: Container,
    CardHeader: Container,
    AlertDialog: Container,
    AlertDialogAction: Button,
    AlertDialogCancel: Button,
    AlertDialogContent: Container,
    AlertDialogDescription: Container,
    AlertDialogFooter: Container,
    AlertDialogHeader: Container,
    AlertDialogTitle: Container,
    Dialog: Container,
    DialogContent: Container,
    DialogDescription: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    Select: Container,
    SelectContent: Container,
    SelectGroup: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: Container,
    ToggleGroup: Container,
    ToggleGroupItem: Button,
  };
});

import { LOG_OUT_FAILED_KEY, syncLogOutFailure } from "../lib/sign-out";
import { PaywallPage } from "../pages/Paywall";
import { CreditChoice } from "./ModelCredits";

afterEach(() => {
  vi.unstubAllGlobals();
  portal.mockClear();
  sessionStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

it("reports a failed log out from the plan choice as a log-out failure", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The reload after a failed log out found the user still signed in.
  sessionStorage.setItem(LOG_OUT_FAILED_KEY, "1");
  syncLogOutFailure(true);

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CreditChoice
        status={
          {
            canManage: true,
            creditPurchasesEnabled: true,
            byokPriceCents: 1000,
            trialAvailable: false,
            trialDays: 7,
          } as never
        }
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not log out. Try again.",
  );
  act(() => root.unmount());
  container.remove();
});

it.each(["past_due", "unpaid", "incomplete", "paused"])(
  "recovers %s through the existing portal without offering another plan",
  async (state) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CreditChoice
          status={
            {
              state,
              access: false,
              canManage: true,
              hasCustomer: true,
              funding: "byok",
              trialAvailable: false,
              byokPriceCents: 1000,
              trialDays: 7,
            } as never
          }
        />,
      );
    });
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe(
      state === "past_due" ? "Update payment method" : "Manage billing",
    );
    expect(container.querySelector('[data-testid="billing-recovery"]')).not.toBeNull();
    if (state === "past_due")
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Payment failed.");
    await act(async () => {
      buttons[0]!.click();
    });
    expect(portal).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not open billing");
    act(() => root.unmount());
  },
);

it("tells a member to ask an owner without showing purchase or billing controls", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <CreditChoice
        status={
          {
            state: "past_due",
            access: false,
            canManage: false,
            hasCustomer: true,
            funding: "credits",
          } as never
        }
      />,
    );
  });
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(container.textContent).toContain("Ask an owner");
  act(() => root.unmount());
});

it.each([undefined, "byok", "credits"] as const)(
  "routes a past-due paywall with funding %s to payment recovery",
  async (funding) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PaywallPage
          status={
            {
              state: "past_due",
              access: false,
              canManage: true,
              hasCustomer: true,
              funding,
            } as never
          }
        />,
      ),
    );
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("button")?.textContent).toBe("Update payment method");
    act(() => root.unmount());
  },
);

it.each(["active", "trialing"])(
  "keeps intentional plan changes for %s and marks the existing own-key plan",
  async (state) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CreditChoice
          dismissible
          status={
            {
              state,
              access: true,
              canManage: true,
              hasCustomer: true,
              funding: "byok",
              byokPriceCents: 1000,
              creditPurchasesEnabled: true,
            } as never
          }
        />,
      ),
    );
    expect(container.querySelector('[data-testid="billing-recovery"]')).toBeNull();
    const upgrade = container.querySelector<HTMLButtonElement>(
      '[aria-label="Subscribe to credits"]',
    );
    expect(upgrade?.disabled).toBe(false);
    act(() => root.unmount());
  },
);
