// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { expect, it, vi } from "vitest";
import { retireBrowserShell } from "./retire";

it("retires the old Ork worker and caches without changing another app", async () => {
  const unregister = vi.fn();
  const otherUnregister = vi.fn();
  const remove = vi.fn();
  const target = {
    location: { origin: "https://ork.example.test" },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [
          {
            scope: "https://ork.example.test/",
            active: { scriptURL: "https://ork.example.test/sw.js" },
            unregister,
          },
          {
            scope: "https://ork.example.test/other/",
            active: { scriptURL: "https://ork.example.test/other/sw.js" },
            unregister: otherUnregister,
          },
        ],
      },
    },
    caches: { keys: async () => ["orkbot-shell-old", "other-app"], delete: remove },
  } as unknown as Window;
  await retireBrowserShell(target);
  expect(unregister).toHaveBeenCalledOnce();
  expect(otherUnregister).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledExactlyOnceWith("orkbot-shell-old");
});

it("does not block connection when service worker access is unavailable", async () => {
  await expect(retireBrowserShell({ navigator: {} } as Window)).resolves.toBeUndefined();
  await expect(
    retireBrowserShell({
      navigator: {
        serviceWorker: {
          getRegistrations: async () => {
            throw new Error("blocked");
          },
        },
      },
    } as unknown as Window),
  ).resolves.toBeUndefined();
});
