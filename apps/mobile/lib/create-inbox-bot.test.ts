// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import { createInboxBot } from "./create-inbox-bot";
import { allowFocusPrompt, scheduleFocusPrompt } from "./focus-prompt";
import { addToSearchInbox } from "./search-inbox";

const scope = vi.hoisted(() => ({
  generation: 1,
  server: "https://fixture.test",
  space: "one",
  selection: 1,
}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({
    apiBase: scope.server,
    sessionGeneration: scope.generation,
    headers: { authorization: "Bearer fixture-token", "x-orkbot-space-id": scope.space },
  }),
  currentApiBase: () => scope.server,
  selectedSpaceId: () => scope.space,
  spaceSelectionSeq: () => scope.selection,
  rpc: vi.fn(),
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => scope.generation }));
vi.mock("./focus-prompt", () => ({ allowFocusPrompt: vi.fn(), scheduleFocusPrompt: vi.fn() }));
vi.mock("./search-inbox", () => ({
  addToSearchInbox: vi.fn(),
  searchInboxSession: () => ({ generation: scope.generation, apiBase: scope.server }),
}));

const bot = { id: "new-bot", name: "New Bot", spaceId: "one" };
const openChat = vi.fn();
const refreshBots = vi.fn(async () => undefined);
const create = () => createInboxBot({ openChat, refreshBots });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  Object.assign(scope, {
    generation: 1,
    server: "https://fixture.test",
    space: "one",
    selection: 1,
  });
  vi.clearAllMocks();
  vi.mocked(rpc).mockImplementation((async (procedure: string) => {
    if (procedure === "bots/list") return [];
    if (procedure === "me") return { needsModel: false };
    if (procedure === "bots/create") return bot;
    return {};
  }) as typeof rpc);
});

describe("inbox bot creation ownership", () => {
  it("opens model settings before creating a first bot with no usable model", async () => {
    vi.mocked(rpc).mockImplementation((async (procedure: string) =>
      procedure === "me" ? { needsModel: true } : []) as typeof rpc);
    await create();
    expect(openChat).toHaveBeenCalledExactlyOnceWith("/(settings)/models");
    expect(vi.mocked(rpc).mock.calls.map(([procedure]) => procedure)).toEqual(["bots/list", "me"]);
    expect(addToSearchInbox).not.toHaveBeenCalled();
  });

  it("binds readiness, creation and onboarding to one immutable request context", async () => {
    await create();
    await vi.waitFor(() => expect(scheduleFocusPrompt).toHaveBeenCalledWith(bot.id, true));
    const calls = vi.mocked(rpc).mock.calls;
    expect(calls.map(([procedure]) => procedure)).toEqual([
      "bots/list",
      "me",
      "bots/create",
      "onboarding/start",
    ]);
    const options = calls[0]![2];
    expect(options).toMatchObject({
      requestContext: {
        apiBase: "https://fixture.test",
        sessionGeneration: 1,
        headers: { "x-orkbot-space-id": "one" },
      },
      skipSpaceAuthRecovery: true,
    });
    expect(calls.every((call) => call[2] === options)).toBe(true);
    expect(openChat).toHaveBeenCalledOnce();
  });

  it.each(["session", "server", "space", "space-roundtrip"])(
    "drops readiness after a %s change",
    async (change) => {
      const waiting = deferred<{ needsModel: boolean }>();
      const original = vi.mocked(rpc).getMockImplementation()!;
      vi.mocked(rpc).mockImplementation(((procedure: string, ...args: unknown[]) =>
        procedure === "me"
          ? waiting.promise
          : Reflect.apply(original, undefined, [procedure, ...args])) as typeof rpc);
      const creating = create();
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
      if (change === "session") scope.generation += 1;
      if (change === "server") scope.server = "https://other.test";
      if (change === "space") scope.space = "two";
      if (change === "space-roundtrip") scope.selection += 2;
      waiting.resolve({ needsModel: false });
      await creating;
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(openChat).not.toHaveBeenCalled();
    },
  );

  it("does not publish or start a bot whose creation completed after logout", async () => {
    const waiting = deferred<typeof bot>();
    const original = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(((procedure: string, ...args: unknown[]) =>
      procedure === "bots/create"
        ? waiting.promise
        : Reflect.apply(original, undefined, [procedure, ...args])) as typeof rpc);
    const creating = create();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    scope.generation += 1;
    waiting.resolve(bot);
    await creating;
    expect(openChat).not.toHaveBeenCalled();
    expect(refreshBots).not.toHaveBeenCalled();
    expect(addToSearchInbox).not.toHaveBeenCalled();
    expect(allowFocusPrompt).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("does not schedule a late onboarding prompt into another Space", async () => {
    const waiting = deferred<object>();
    const original = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(((procedure: string, ...args: unknown[]) =>
      procedure === "onboarding/start"
        ? waiting.promise
        : Reflect.apply(original, undefined, [procedure, ...args])) as typeof rpc);
    await create();
    expect(rpc).toHaveBeenCalledTimes(4);
    scope.space = "two";
    waiting.resolve({});
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scheduleFocusPrompt).not.toHaveBeenCalled();
  });

  it("does not create when authoritative readiness cannot be loaded", async () => {
    const original = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(((procedure: string, ...args: unknown[]) =>
      procedure === "me"
        ? Promise.reject(new Error("offline"))
        : Reflect.apply(original, undefined, [procedure, ...args])) as typeof rpc);
    await expect(create()).rejects.toThrow("offline");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(openChat).not.toHaveBeenCalled();
  });

  it("preserves ordinary later-bot creation when the account has no main model", async () => {
    const original = vi.mocked(rpc).getMockImplementation()!;
    vi.mocked(rpc).mockImplementation(((procedure: string, ...args: unknown[]) =>
      procedure === "me"
        ? Promise.resolve({ needsModel: true })
        : procedure === "bots/list"
          ? Promise.resolve([bot])
          : Reflect.apply(original, undefined, [procedure, ...args])) as typeof rpc);
    await create();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(vi.mocked(rpc).mock.calls.some(([path]) => path === "bots/create")).toBe(true);
    expect(openChat).toHaveBeenCalledExactlyOnceWith({
      pathname: "/thread",
      params: { botId: bot.id, name: bot.name },
    });
    expect(scheduleFocusPrompt).toHaveBeenCalledWith(bot.id, false);
  });
});
