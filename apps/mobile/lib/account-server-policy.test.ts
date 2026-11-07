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
  await expect(requireAccountsSignIn("https://server.example.test")).resolves.toEqual({
    accountsLogin: false,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://server.example.test/api/auth/capabilities",
    expect.objectContaining({ headers: {}, credentials: "omit", redirect: "error" }),
  );
});

it.each([
  { passwordAuth: true, accountsLogin: true, sso: null },
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

it("accepts native Accounts proofs without an OIDC provider", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(Response.json({ passwordAuth: false, accountsLogin: true, sso: null })),
  );
  await expect(requireAccountsSignIn("https://server.example.test")).resolves.toEqual({
    accountsLogin: true,
  });
});

it.each([undefined, { min: 1, max: 1 }, { min: 1.0, max: Number.MAX_SAFE_INTEGER }])(
  "accepts a legacy or supported protocol range %j",
  async (protocol) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          passwordAuth: false,
          accountsLogin: true,
          protocol,
        }),
      ),
    );
    await expect(requireAccountsSignIn("https://server.example.test")).resolves.toEqual({
      accountsLogin: true,
    });
  },
);

it.each([
  null,
  "1",
  { min: 0, max: 1 },
  { min: -1, max: 1 },
  { min: 1.5, max: 2 },
  { min: "1", max: 1 },
  { min: 1 },
  { min: 2, max: 1 },
  { min: 1, max: Number.MAX_SAFE_INTEGER + 1 },
  { min: 1, max: 1, extra: true },
])("rejects an explicitly malformed protocol range %j", async (protocol) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        passwordAuth: false,
        accountsLogin: true,
        protocol,
      }),
    ),
  );
  await expect(requireAccountsSignIn("https://server.example.test")).rejects.toThrow(
    "Could not load sign-in options",
  );
});

it("asks for an app update when the server requires a newer protocol", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        passwordAuth: false,
        accountsLogin: true,
        protocol: { min: 2, max: 3 },
      }),
    ),
  );
  await expect(requireAccountsSignIn("https://server.example.test")).rejects.toThrow(
    "Update Ork to connect to this server.",
  );
});
