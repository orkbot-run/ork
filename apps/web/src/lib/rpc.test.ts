// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material; native revocation retry regressions are PolyForm-covered. See LICENSE.md.

import { CLIENT_PROTOCOL_HEADER, CLIENT_PROTOCOL_VERSION } from "@orkbot/contracts";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerAiConsent, currentAiConsentPrompt, subscribeAiConsent } from "./ai-consent";
import {
  captureRpcContext,
  clearSpaceSelection,
  createSpaceRpc,
  leaveUnavailableSpace,
  onRpcResponse,
  rpc,
  rpcForSpace,
  SPACE_SELECTED_EVENT,
  selectedSpaceId,
  selectSpace,
} from "./rpc.js";

const notify = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({ sessionId: "fixture-session" }));
vi.mock("./auth", () => ({
  authClient: {
    $store: {
      notify,
      atoms: { session: { get: () => ({ data: { session: { id: authState.sessionId } } }) } },
    },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  notify.mockClear();
  authState.sessionId = "fixture-session";
});

describe("signed-out responses", () => {
  it("retries captured native revocations only after successful API replies", async () => {
    const retryRevocations = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      location: { origin: "https://app.example.test" },
      orkbotDesktop: { accounts: { retryRevocations } },
    });
    const fetch = vi.fn(async () => Response.json({ json: {} }));
    vi.stubGlobal("fetch", fetch);
    await rpc.me();
    await vi.waitFor(() => expect(retryRevocations).toHaveBeenCalledOnce());
    retryRevocations.mockClear();
    fetch.mockImplementation(async () =>
      Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 }),
    );
    await expect(rpc.me()).rejects.toMatchObject({ status: 401 });
    expect(retryRevocations).not.toHaveBeenCalled();
  });

  it.each([rpc, createSpaceRpc("space-a")])(
    "advertises the wire protocol on RPC requests without changing cookie authentication",
    async (client) => {
      const fetch = vi.fn(async (_request: Request, _init: RequestInit) =>
        Response.json({ json: {} }),
      );
      vi.stubGlobal("fetch", fetch);
      await client.me();
      expect(new Headers(fetch.mock.calls[0]?.[1].headers).get(CLIENT_PROTOCOL_HEADER)).toBe(
        String(CLIENT_PROTOCOL_VERSION),
      );
      expect(fetch.mock.calls[0]?.[1].credentials).toBe("include");
    },
  );

  it("preserves cookie authentication, oRPC error identity and server error data", async () => {
    const fetch = vi.fn(async (_request: Request, _init: RequestInit) =>
      Response.json(
        {
          json: {
            defined: true,
            code: "CONFLICT",
            status: 409,
            message: "Changed",
            data: { revision: 3 },
          },
        },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const error = await rpc.me().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "CONFLICT", status: 409, data: { revision: 3 } });
    expect(fetch.mock.calls[0]?.[1].credentials).toBe("include");
  });

  it("exposes compatibility headers before an invalid response body is decoded", async () => {
    const seen = vi.fn();
    const stop = onRpcResponse((response) =>
      seen(response.status, response.headers.get("x-orkbot-build")),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 426,
            headers: { "x-orkbot-build": "20261107000000" },
          }),
      ),
    );
    try {
      await expect(rpc.me()).rejects.toMatchObject({ status: 426 });
      expect(seen).toHaveBeenCalledWith(426, "20261107000000");
    } finally {
      stop();
    }
  });

  it("rechecks the session when the server answers 401, and only then", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(rpc.me()).rejects.toMatchObject({ status: 401 });
    expect(notify).toHaveBeenCalledWith("$sessionSignal");

    notify.mockClear();
    fetch.mockImplementation(async () =>
      Response.json({ json: { code: "INTERNAL_SERVER_ERROR", status: 500 } }, { status: 500 }),
    );
    await expect(rpc.me()).rejects.toMatchObject({ status: 500 });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("unavailable space", () => {
  function browser(selected: string, spaces: string[] | null) {
    const items = new Map([["orkbot:space-id", selected]]);
    const reload = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
      location: { origin: "http://app.example", reload },
    });
    const fetch = vi.fn(async (_request: Request, init?: RequestInit) => {
      if (!spaces)
        return Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 });
      expect(new Headers(init?.headers).has("x-orkbot-space-id")).toBe(false);
      return Response.json({
        json: {
          activeOrganizationId: "personal",
          organizations: [
            {
              id: "personal",
              name: "Personal",
              defaultSpaceId: "home",
              spaceIds: spaces,
              canManage: true,
            },
            {
              id: "work",
              name: "Work",
              defaultSpaceId: "work-home",
              spaceIds: ["work-home"],
              canManage: true,
            },
            {
              id: "team",
              name: "Team",
              defaultSpaceId: "team-home",
              spaceIds: ["team-home"],
              canManage: false,
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetch);
    return { items, reload };
  }

  it("drops a space the user is no longer in and reloads", async () => {
    const { items, reload } = browser("space-gone", ["home"]);
    items.set("orkbot:org-spaces", JSON.stringify({ work: "work-home" }));
    await leaveUnavailableSpace("space-gone");
    expect(items.has("orkbot:space-id")).toBe(false);
    expect(items.get("orkbot:org-spaces")).toBe(JSON.stringify({ work: "work-home" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recovers from a 401 on the shell's space-bound client", async () => {
    const { items, reload } = browser("space-gone", ["home"]);
    const fetch = vi.mocked(globalThis.fetch);
    const list = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (request, init) =>
      new Headers(init?.headers).get("x-orkbot-space-id") === "space-gone"
        ? Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 })
        : list(request, init),
    );
    await expect(createSpaceRpc("space-gone").me()).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(items.has("orkbot:space-id")).toBe(false);
  });

  it("keeps a space the user still has, and keeps it when signed out", async () => {
    for (const spaces of [["home", "space-a"], null]) {
      const { items, reload } = browser("space-a", spaces);
      await leaveUnavailableSpace("space-a");
      expect(items.get("orkbot:space-id")).toBe("space-a");
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("keeps a space in an organization the user is only a member of", async () => {
    const { items, reload } = browser("team-home", ["home"]);
    await leaveUnavailableSpace("team-home");
    expect(items.get("orkbot:space-id")).toBe("team-home");
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps a space that belongs to another of the user's organizations", async () => {
    const { items, reload } = browser("work-home", ["home"]);
    await leaveUnavailableSpace("work-home");
    expect(items.get("orkbot:space-id")).toBe("work-home");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("space selection storage", () => {
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage, dispatchEvent: () => true });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("announces a new selection so per-organization state reloads", () => {
    const items = new Map<string, string>();
    const dispatchEvent = vi.fn(() => true);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
      dispatchEvent,
    });

    expect(selectSpace("space-support")).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: SPACE_SELECTED_EVENT }),
    );
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "orkbot:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage, dispatchEvent: () => true });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage, dispatchEvent: () => true });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("orkbot:space-id", "space-support");
  });
});

describe("shell RPC space isolation", () => {
  it.each([rpc, createSpaceRpc("space-a")])(
    "passes the caller's cancellation signal directly to fetch",
    async (client) => {
      const controller = new AbortController();
      const fetch = vi.fn(async (_request: Request, _init: RequestInit) =>
        Response.json({ json: {} }),
      );
      vi.stubGlobal("fetch", fetch);

      await client.me(undefined, { signal: controller.signal });

      const signal = fetch.mock.calls[0]?.[1].signal;
      expect(signal).toBe(controller.signal);
      controller.abort("thread retired");
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe("thread retired");
    },
  );

  it.each(["space-a", null])(
    "keeps async follow-up requests in the original space %s after selection changes",
    async (originalSpace) => {
      let selected = originalSpace;
      vi.stubGlobal("window", {
        location: { origin: "https://example.test", pathname: "/app" },
        localStorage: { getItem: () => selected },
      });
      const fetch = vi.fn(async (_input: Request, _init: RequestInit) =>
        Response.json({
          json: new URL(_input.url).pathname.endsWith("/status")
            ? { scope: "fixture", version: "fixture", recipients: [] }
            : {},
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const shellRpc = createSpaceRpc(selectedSpaceId());
      await shellRpc.me();
      selected = "space-b";
      // For example, an upload continues after reading a file or awaiting another RPC.
      await shellRpc.artifacts.create({
        botId: "bot-a",
        name: "example.txt",
        mimeType: "text/plain",
        contentBase64: "ZXhhbXBsZQ==",
      });
      await rpc.me();
      const headers = fetch.mock.calls.map((call) => {
        const init = call[1];
        return new Headers(init.headers).get("x-orkbot-space-id");
      });
      expect(headers).toEqual([originalSpace, originalSpace, originalSpace, "space-b"]);
    },
  );

  it.each([createSpaceRpc, rpcForSpace])(
    "honours a space a call names explicitly with %s",
    async (clientForSpace) => {
      vi.stubGlobal("window", {
        location: { origin: "https://example.test", pathname: "/app" },
        localStorage: { getItem: () => "space-a" },
      });
      const fetch = vi.fn(async (_input: Request, _init: RequestInit) =>
        Response.json({ json: {} }),
      );
      vi.stubGlobal("fetch", fetch);
      const shellRpc = clientForSpace("space-a");
      await shellRpc.me(undefined, { context: { spaceId: "space-b" } });
      await shellRpc.me(undefined, { context: { spaceId: null } });
      await shellRpc.me();
      const headers = fetch.mock.calls.map((call) =>
        new Headers(call[1].headers).get("x-orkbot-space-id"),
      );
      expect(headers).toEqual(["space-b", null, "space-a"]);
    },
  );
});

describe("space-bound clients", () => {
  function stubSelection(selected: string) {
    const localStorage = {
      getItem: (key: string) => (key === "orkbot:space-id" ? selected : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const sent: Array<string | null> = [];
    vi.stubGlobal("window", {
      localStorage,
      location: { origin: "http://test", pathname: "/app" },
    });
    vi.stubGlobal("localStorage", localStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request, init?: RequestInit) => {
        sent.push(new Headers(init?.headers ?? request.headers).get("x-orkbot-space-id"));
        return Response.json({ json: null });
      }),
    );
    return sent;
  }

  it("sends its own space whichever space is selected", async () => {
    const sent = stubSelection("space-selected");
    await rpcForSpace("space-other").usage.summary();
    await rpc.usage.summary();
    expect(sent).toEqual(["space-other", "space-selected"]);
  });

  it("reuses one client per space", () => {
    expect(rpcForSpace("space-a")).toBe(rpcForSpace("space-a"));
    expect(rpcForSpace("space-a")).not.toBe(rpcForSpace("space-b"));
  });
});

describe("send disclosure boundaries", () => {
  function setup() {
    const values = new Map([["orkbot:space-id", "space-a"]]);
    vi.stubGlobal("window", {
      location: { origin: "https://app.example.test" },
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      dispatchEvent: vi.fn(),
    });
    const calls: Array<{ path: string; body: Record<string, unknown>; space: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request, init: RequestInit) => {
        const path = new URL(request.url).pathname;
        calls.push({
          path,
          body: JSON.parse(String(init.body)).json,
          space: new Headers(init.headers).get("x-orkbot-space-id"),
        });
        return Response.json({
          json: path.endsWith("/status")
            ? {
                scope: "account-space",
                version: "fixture-version",
                recipients: [
                  { key: "first", name: "First", use: "model", detail: "", allowed: false },
                  { key: "second", name: "Second", use: "model", detail: "", allowed: false },
                ],
              }
            : {},
        });
      }),
    );
    return calls;
  }
  const input = {
    botId: "active",
    routineIds: ["paused-a", "paused-b"],
    text: "Draft",
    clientNonce: "nonce",
  };
  it("does not send or grant when the first recipient is declined", async () => {
    const calls = setup();
    const stop = subscribeAiConsent(() => undefined);
    try {
      const failed = rpc.threads.sendWithRoutines(input).catch((error: unknown) => error);
      await vi.waitFor(() => expect(currentAiConsentPrompt()).not.toBeNull());
      answerAiConsent(currentAiConsentPrompt()!, false);
      expect(await failed).toBeInstanceOf(Error);
      expect(calls.map((call) => call.path)).toEqual(["/rpc/aiConsent/status"]);
      expect(calls[0]?.body).toMatchObject({
        botId: "active",
        routineIds: ["paused-a", "paused-b"],
      });
    } finally {
      stop();
    }
  });
  it("grants every disclosed recipient against the same target before dispatching once", async () => {
    const calls = setup();
    const stop = subscribeAiConsent(() => undefined);
    try {
      const request = rpc.threads.sendWithRoutines(input);
      await vi.waitFor(() => expect(currentAiConsentPrompt()?.recipient.key).toBe("first"));
      answerAiConsent(currentAiConsentPrompt()!, true);
      await vi.waitFor(() => expect(currentAiConsentPrompt()?.recipient.key).toBe("second"));
      answerAiConsent(currentAiConsentPrompt()!, true);
      await request;
      expect(calls.map((call) => call.path)).toEqual([
        "/rpc/aiConsent/status",
        "/rpc/aiConsent/allow",
        "/rpc/aiConsent/allow",
        "/rpc/threads/sendWithRoutines",
      ]);
      for (const call of calls) {
        expect(call.space).toBe("space-a");
        expect(call.body).toMatchObject({ botId: "active", routineIds: ["paused-a", "paused-b"] });
      }
      expect(calls.slice(1, 3).map((call) => call.body.keys)).toEqual([["first"], ["second"]]);
    } finally {
      stop();
    }
  });
  it.each(["session", "space", "server"])(
    "prevents a pending old-context grant and send after a %s change",
    async (boundary) => {
      const calls = setup();
      const stop = subscribeAiConsent(() => undefined);
      try {
        const failed = rpc.threads.sendWithRoutines(input).catch((error: unknown) => error);
        await vi.waitFor(() => expect(currentAiConsentPrompt()).not.toBeNull());
        const prompt = currentAiConsentPrompt()!;
        if (boundary === "session") authState.sessionId = "other-session";
        else if (boundary === "space") {
          selectSpace("space-b");
          selectSpace("space-a");
        } else
          vi.stubGlobal("window", {
            ...window,
            location: { origin: "https://other.example.test" },
          });
        answerAiConsent(prompt, true);
        expect(await failed).toBeInstanceOf(Error);
        expect(calls.map((call) => call.path)).toEqual(["/rpc/aiConsent/status"]);
      } finally {
        stop();
      }
    },
  );
});

describe("captured model configuration context", () => {
  function setup() {
    const items = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { origin: "https://app.example.test" },
      dispatchEvent: vi.fn(),
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
    selectSpace("source");
    const fetch = vi.fn(async (_request: Request) => Response.json({ json: {} }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  it("binds all stages to the explicit originating Space", async () => {
    const fetch = setup();
    const scope = captureRpcContext("edited-space");
    await scope.client.me();
    await scope.client.models.list();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [request] of fetch.mock.calls)
      expect((request as unknown as Request).headers.get("x-orkbot-space-id")).toBe("edited-space");
  });
  it.each(["session", "server", "space-roundtrip"])(
    "rejects late results and follow-ups after %s changes",
    async (boundary) => {
      const fetch = setup();
      let resolve!: (value: Response) => void;
      fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      const scope = captureRpcContext();
      const result = scope.client.me().catch((error: unknown) => error);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      if (boundary === "session") authState.sessionId = "new-session";
      else if (boundary === "server")
        vi.stubGlobal("window", { ...window, location: { origin: "https://other.example.test" } });
      else {
        selectSpace("other");
        selectSpace("source");
      }
      resolve(Response.json({ json: {} }));
      expect(await result).toBeInstanceOf(Error);
      await expect(scope.client.models.list()).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
});

it.each(["account", "server", "space-roundtrip"])(
  "a retired captured context cannot clear replacement scope on a late 401 after %s changes",
  async (boundary) => {
    const items = new Map<string, string>([["orkbot:space-id", "shared-space"]]);
    const reload = vi.fn();
    vi.stubGlobal("window", {
      location: { origin: "https://app.example.test", reload },
      dispatchEvent: vi.fn(),
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => items.set(key, value),
        removeItem: (key: string) => items.delete(key),
      },
    });
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const owner = captureRpcContext();
    const result = owner.client.me().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    if (boundary === "account") authState.sessionId = "replacement-session";
    else if (boundary === "server")
      vi.stubGlobal("window", {
        ...window,
        location: { ...window.location, origin: "https://other.example.test" },
      });
    else {
      selectSpace("other");
      selectSpace("shared-space");
    }
    resolve(Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 }));
    expect(await result).toMatchObject({ name: "AbortError" });
    await expect(owner.client.models.list()).rejects.toMatchObject({ name: "AbortError" });
    expect(notify).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(items.get("orkbot:space-id")).toBe("shared-space");
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("rejects a captured result when ownership changes while its response body is still parsing", async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test" },
    localStorage: { getItem: () => null },
  });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  const fetch = vi.fn(
    async () => new Response(body, { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const scope = captureRpcContext();
  const result = scope.client.me().catch((error: unknown) => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  authState.sessionId = "other-session";
  stream.enqueue(
    new TextEncoder().encode(JSON.stringify({ json: { userId: "previous-account" } })),
  );
  stream.close();
  expect(await result).toMatchObject({ name: "AbortError" });
  await expect(scope.client.models.list()).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not leave the replacement Space when an old 401 recovery's membership read resolves late", async () => {
  const items = new Map<string, string>([["orkbot:space-id", "shared-space"]]);
  const reload = vi.fn();
  vi.stubGlobal("window", {
    location: { origin: "https://app.example.test", reload },
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      removeItem: (key: string) => items.delete(key),
    },
  });
  let release!: (response: Response) => void;
  const fetch = vi.fn(async (request: Request) =>
    new URL(request.url).pathname.endsWith("/organizations/list")
      ? new Promise<Response>((done) => {
          release = done;
        })
      : Response.json({ json: { code: "UNAUTHORIZED", status: 401 } }, { status: 401 }),
  );
  vi.stubGlobal("fetch", fetch);
  const scope = captureRpcContext();
  const result = scope.client.me().catch((error: unknown) => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  authState.sessionId = "other-session";
  release(Response.json({ json: { organizations: [] } }));
  await result;
  await new Promise<void>((done) => setTimeout(done, 0));
  expect(items.get("orkbot:space-id")).toBe("shared-space");
  expect(reload).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
});
