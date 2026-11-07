// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { beforeEach, expect, it, vi } from "vitest";
import { captureApiRequestContext, rpc } from "./api";
import {
  closeModelConnection,
  modelConnectionRequest,
  openModelConnection,
} from "./model-connection-request";
import { ACCOUNT_SETTINGS, captureSettingsContext } from "./settings-target";

const scope = vi.hoisted(() => ({
  generation: 1,
  server: "https://fixture.test",
  space: "origin",
  selection: 1,
}));
vi.mock("./api", () => ({
  currentApiBase: () => scope.server,
  selectedSpaceId: () => scope.space,
  spaceSelectionSeq: () => scope.selection,
  captureApiRequestContext: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => scope.generation }));
const context = {
  apiBase: "https://fixture.test",
  sessionGeneration: 1,
  headers: { authorization: "Bearer fixture" },
};
beforeEach(() => {
  Object.assign(scope, {
    generation: 1,
    server: "https://fixture.test",
    space: "origin",
    selection: 1,
  });
  vi.clearAllMocks();
  vi.mocked(captureApiRequestContext).mockResolvedValue(context);
  vi.mocked(rpc).mockResolvedValue(undefined as never);
});

it("captures one context for readiness, save and follow-ups in an explicitly edited Space", async () => {
  const owner = captureSettingsContext({ scope: "space", spaceId: "edited" });
  await owner.send("me");
  await owner.send("models/list");
  expect(captureApiRequestContext).toHaveBeenCalledExactlyOnceWith("edited");
  for (const call of vi.mocked(rpc).mock.calls)
    expect(call[2]).toEqual({ requestContext: context, skipSpaceAuthRecovery: true });
});

it.each(["generation", "server", "space-roundtrip"])(
  "rejects both late work and its follow-up after a %s change",
  async (boundary) => {
    let resolve!: (value: never) => void;
    vi.mocked(rpc).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const owner = captureSettingsContext(ACCOUNT_SETTINGS);
    const pending = owner.send("me").catch((error: unknown) => error);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    if (boundary === "generation") scope.generation++;
    else if (boundary === "server") scope.server = "https://other.test";
    else {
      scope.space = "other";
      scope.selection++;
      scope.space = "origin";
      scope.selection++;
    }
    resolve(undefined as never);
    expect(await pending).toBeInstanceOf(Error);
    await expect(owner.send("models/list")).rejects.toThrow("Session changed");
    expect(rpc).toHaveBeenCalledOnce();
  },
);

it("does not rebind an intent queued before logout when its native screen mounts later", async () => {
  const id = openModelConnection({
    provider: "fixture",
    credentialId: null,
    makeDefault: true,
    target: ACCOUNT_SETTINGS,
  });
  scope.generation++;
  try {
    const request = modelConnectionRequest(id)!;
    expect(request.context.isCurrent()).toBe(false);
    await expect(request.context.send("me")).rejects.toThrow("Session changed");
    expect(rpc).not.toHaveBeenCalled();
  } finally {
    closeModelConnection(id);
  }
});

it("checks ownership after delayed token capture, before dispatching any request", async () => {
  let resolve!: (value: typeof context) => void;
  vi.mocked(captureApiRequestContext).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const owner = captureSettingsContext(ACCOUNT_SETTINGS);
  const pending = owner.send("me").catch((error: unknown) => error);
  scope.generation++;
  resolve(context);
  expect(await pending).toBeInstanceOf(Error);
  expect(rpc).not.toHaveBeenCalled();
});
