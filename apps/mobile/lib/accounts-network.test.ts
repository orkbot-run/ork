// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import { AccountsUnavailable, fetchAccounts } from "./accounts-network";

afterEach(() => vi.unstubAllGlobals());
it("classifies transport failure as unavailable without retaining request details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection closed")));
  await expect(fetchAccounts("https://accounts.example.test")).rejects.toBeInstanceOf(
    AccountsUnavailable,
  );
});
it.each([500, 502, 503, 504])(
  "allows existing personal authority during HTTP %s service outages",
  async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await expect(fetchAccounts("https://accounts.example.test")).rejects.toBeInstanceOf(
      AccountsUnavailable,
    );
  },
);
it.each([200, 400, 401, 403, 409, 410, 426, 429])(
  "preserves authoritative HTTP %s for its caller",
  async (status) => {
    const response = new Response(null, { status });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await fetchAccounts("https://accounts.example.test")).toBe(response);
  },
);
