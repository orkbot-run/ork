// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import { requireAccountsSignIn } from "./endpoint";

vi.mock("./i18n", () => ({ t: (value: string) => value }));
afterEach(() => vi.unstubAllGlobals());

it("checks the product's Accounts-only capability without any central credential", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ passwordAuth: false, sso: { name: "Accounts", availability: "available" } }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(requireAccountsSignIn("https://server.example.test")).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledWith(
    "https://server.example.test/api/auth/capabilities",
    expect.objectContaining({ headers: {}, credentials: "omit", redirect: "error" }),
  );
});

it.each([
  { passwordAuth: true, sso: { name: "Accounts" } },
  { passwordAuth: false, sso: null },
  { passwordAuth: false, sso: { name: 42 } },
  { passwordAuth: false, sso: { name: "Accounts", availability: "unavailable" } },
  { passwordAuth: false, sso: { name: "", availability: "available" } },
  { passwordAuth: false },
])("rejects legacy or invalid sign-in policy %j", async (policy) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(policy)));
  await expect(requireAccountsSignIn("https://server.example.test")).rejects.toThrow(
    "must use Accounts sign-in",
  );
});
