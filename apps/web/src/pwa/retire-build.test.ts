// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { browserShellRetirementSource } from "./retire-build.js";

it("replaces an installed worker, clears only legacy Ork caches, and unregisters", async () => {
  const listeners = new Map<
    string,
    (event: { waitUntil: (promise: Promise<unknown>) => void }) => void
  >();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const unregister = vi.fn(async () => undefined);
  const remove = vi.fn(async () => true);
  runInNewContext(browserShellRetirementSource(), {
    self: {
      addEventListener: (
        name: string,
        listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => void,
      ) => listeners.set(name, listener),
      skipWaiting,
      clients: { claim },
      registration: { unregister },
    },
    caches: { keys: async () => ["orkbot-shell-previous", "unrelated"], delete: remove },
  });
  let operation: Promise<unknown> | undefined;
  const event = {
    waitUntil: (promise: Promise<unknown>) => {
      operation = promise;
    },
  };
  listeners.get("install")!(event);
  await operation;
  expect(skipWaiting).toHaveBeenCalledOnce();
  listeners.get("activate")!(event);
  await operation;
  expect(remove).toHaveBeenCalledExactlyOnceWith("orkbot-shell-previous");
  expect(claim).toHaveBeenCalledOnce();
  expect(unregister).toHaveBeenCalledOnce();
  expect(listeners.has("fetch")).toBe(false);
});
