// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  APIStatusError,
  AuthenticationError as BoxdAuthenticationError,
  PermissionDeniedError,
} from "@boxd-sh/sdk";
import { DaytonaAuthenticationError, DaytonaError, DaytonaNotFoundError } from "@daytona/sdk";
import { AuthenticationError, SandboxError } from "@e2b/desktop";
import { SandboxAccountError } from "@orkbot/adapter-kit";
import { COMPUTER_ACCOUNT_REFUSED_ERROR } from "@orkbot/contracts";
import { AuthenticationError as NovitaAuthenticationError } from "novita-sandbox";
import { RailwayGraphQLError, Sandbox } from "railway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoatSandboxProvider } from "./boat-sandbox.js";
import { boatError, FakeBoatApi } from "./boat-sandbox.test-support.js";
import { FakeBoxd, fakeBoxdProvider } from "./boxd-sandbox.test-support.js";
import { CreateOSHttpError, CreateOSSandboxProvider } from "./createos-sandbox.js";
import type { DaytonaSandboxSdk } from "./daytona-sandbox.js";
import { DaytonaSandboxProvider } from "./daytona-sandbox.js";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";
import { fakeNovita } from "./novita-sandbox.test-support.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";

const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const request = { botId: "bot", homePath: "/unused" };
afterEach(() => vi.restoreAllMocks());

async function accountRefusal(pending: Promise<unknown>) {
  const error = await pending.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(SandboxAccountError);
  expect(error).toMatchObject({ message: COMPUTER_ACCOUNT_REFUSED_ERROR });
  expect(error).not.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining("fake-private") }),
  });
  return error;
}

function remoteSdk(error: Error): E2BSandboxSdk {
  return {
    create: vi.fn().mockRejectedValue(error),
    connect: vi.fn().mockRejectedValue(error),
    pause: vi.fn(),
    kill: vi.fn(),
  };
}

describe("computer account refusal at startup", () => {
  it.each([false, true])("E2B authentication on reconnect=%s", async (reconnect) => {
    const sdk = remoteSdk(new AuthenticationError("fake-private-key"));
    await accountRefusal(
      new E2BSandboxProvider("fake-private-key", sdk).provision(
        {
          ...request,
          ...(reconnect ? { providerRef: "existing", providerKind: "e2b" as const } : {}),
        },
        context,
      ),
    );
    expect(sdk.create).toHaveBeenCalledTimes(reconnect ? 0 : 1);
  });
  it.each([401, 402])("E2B structured HTTP %s", async (statusCode) => {
    const sdk = remoteSdk(Object.assign(new SandboxError("fake-private-body"), { statusCode }));
    await accountRefusal(new E2BSandboxProvider("key", sdk).provision(request, context));
  });
  it.each([403, 429, 500, undefined])(
    "does not infer E2B account refusal from %s or text",
    async (statusCode) => {
      const error = Object.assign(new SandboxError("account payment required"), { statusCode });
      await expect(
        new E2BSandboxProvider("key", remoteSdk(error)).provision(request, context),
      ).rejects.toBe(error);
    },
  );
  it("maps refusal from the fallback E2B create without a third create", async () => {
    const sdk = remoteSdk(new AuthenticationError("fake-private-key"));
    vi.mocked(sdk.create).mockRejectedValueOnce(
      Object.assign(new SandboxError("404: template 'orkbot-computer' not found"), {
        statusCode: 404,
      }),
    );
    await accountRefusal(new E2BSandboxProvider("key", sdk).provision(request, context));
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });
  it("does not replace an E2B computer when an authentication response mentions a missing sandbox", async () => {
    const sdk = remoteSdk(new AuthenticationError("sandbox existing not found"));
    await accountRefusal(
      new E2BSandboxProvider("key", sdk).provision(
        { ...request, providerRef: "existing", providerKind: "e2b" },
        context,
      ),
    );
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it.each([false, true])("Novita typed authentication on reconnect=%s", async (reconnect) => {
    const { provider, sdk } = fakeNovita();
    vi.mocked(sdk.create).mockRejectedValue(new NovitaAuthenticationError("fake-private-key"));
    vi.mocked(sdk.connect).mockRejectedValue(new NovitaAuthenticationError("fake-private-key"));
    await accountRefusal(
      provider.provision(
        {
          ...request,
          ...(reconnect ? { providerRef: "existing", providerKind: "novita" as const } : {}),
        },
        context,
      ),
    );
    expect(sdk.create).toHaveBeenCalledTimes(reconnect ? 0 : 1);
  });
  it("does not parse Novita prose as a payment status", async () => {
    const { provider, sdk } = fakeNovita();
    const error = new Error("402: insufficient balance");
    vi.mocked(sdk.create).mockRejectedValue(error);
    await expect(provider.provision(request, context)).rejects.toBe(error);
  });
  it.each([false, true])("Boat structured authentication on reconnect=%s", async (reconnect) => {
    const api = new FakeBoatApi();
    const provider = new BoatSandboxProvider({ apiKey: "key" }, api);
    const existing = reconnect ? await provider.provision(request, context) : undefined;
    api.unauthorized();
    await accountRefusal(
      provider.provision(
        {
          ...request,
          ...(existing ? { providerRef: existing.providerRef, providerKind: "boat" as const } : {}),
        },
        context,
      ),
    );
    if (existing) expect(api.state(existing.id)).toBe("ready");
  });
  it("keeps Boat payment refusal separate from size restrictions and rate limits", async () => {
    const api = new FakeBoatApi();
    vi.spyOn(api, "create").mockRejectedValue(
      boatError(402, "payment_required", "fake-private-body"),
    );
    const provider = new BoatSandboxProvider({ apiKey: "key" }, api);
    await accountRefusal(provider.provision(request, context));
  });
  it.each([false, true])(
    "boxd authentication on reconnect=%s keeps owned cleanup",
    async (reconnect) => {
      const fake = new FakeBoxd();
      const provider = fakeBoxdProvider(fake);
      const existing = reconnect ? await provider.provision(request, context) : undefined;
      fake.failures.set(reconnect ? "get" : "create", [
        new BoxdAuthenticationError("fake-private-key"),
      ]);
      await accountRefusal(
        provider.provision(
          {
            ...request,
            ...(existing ? { providerRef: existing.id, providerKind: "boxd" as const } : {}),
          },
          context,
        ),
      );
      if (existing) expect(fake.machines.has(existing.id)).toBe(true);
      else expect(fake.calls).toContain("delete");
    },
  );
  it.each([
    new PermissionDeniedError("resource forbidden", 7),
    new APIStatusError("outage", undefined, { httpStatus: 503 }),
  ])("does not relabel boxd resource permissions or outages", async (error) => {
    const fake = new FakeBoxd();
    const provider = fakeBoxdProvider(fake);
    fake.failures.set("create", [error]);
    await expect(provider.provision(request, context)).rejects.toBe(error);
  });
  it("maps structured boxd payment refusal after create cleanup", async () => {
    const fake = new FakeBoxd();
    const provider = fakeBoxdProvider(fake);
    fake.failures.set("create", [
      new APIStatusError("fake-private-body", undefined, { httpStatus: 402 }),
    ]);
    await accountRefusal(provider.provision(request, context));
    expect(fake.calls).toContain("delete");
  });
  it("maps a Daytona control-plane payment refusal after abandoned-create cleanup", async () => {
    const get = vi.fn().mockRejectedValue(new DaytonaNotFoundError("missing", 404));
    const provider = new DaytonaSandboxProvider({ apiKey: "key" }, {
      create: vi
        .fn()
        .mockRejectedValue(
          new DaytonaError("fake-private-body", 402, undefined, undefined, "DAYTONA_API"),
        ),
      get,
    } as unknown as DaytonaSandboxSdk);
    await accountRefusal(provider.provision(request, context));
    expect(get).toHaveBeenCalledOnce();
  });
  it.each([false, true])("Daytona authentication on reconnect=%s", async (reconnect) => {
    const failure = new DaytonaAuthenticationError("fake-private-key", 401);
    const create = vi.fn().mockRejectedValue(failure);
    const get = vi
      .fn()
      .mockRejectedValue(reconnect ? failure : new DaytonaNotFoundError("missing", 404));
    const provider = new DaytonaSandboxProvider({ apiKey: "key" }, {
      create,
      get,
    } as unknown as DaytonaSandboxSdk);
    await accountRefusal(
      provider.provision(
        {
          ...request,
          ...(reconnect ? { providerRef: "existing", providerKind: "daytona" as const } : {}),
        },
        context,
      ),
    );
    expect(create).toHaveBeenCalledTimes(reconnect ? 0 : 1);
    expect(get).toHaveBeenCalledOnce();
  });
  it.each([
    new DaytonaError("403 account refused", 403),
    new DaytonaError("daemon auth", 401, undefined, undefined, "DAYTONA_DAEMON"),
    new DaytonaError("proxy payment", 402, undefined, undefined, "DAYTONA_PROXY"),
  ])("does not relabel opaque permission or in-computer Daytona errors", async (error) => {
    const provider = new DaytonaSandboxProvider({ apiKey: "key" }, {
      create: vi.fn().mockRejectedValue(error),
      get: vi.fn().mockRejectedValue(new DaytonaNotFoundError("missing", 404)),
    } as unknown as DaytonaSandboxSdk);
    await expect(provider.provision(request, context)).rejects.toBe(error);
  });
  it.each([401, 402])(
    "Railway structured status %s is terminal without idle fallback",
    async (status) => {
      const create = vi
        .spyOn(Sandbox, "create")
        .mockRejectedValue(new RailwayGraphQLError({ message: "fake-private-key", status }));
      const provider = new RailwaySandboxProvider({ token: "key", environmentId: "test" });
      await accountRefusal(provider.provision(request, context));
      expect(create).toHaveBeenCalledOnce();
    },
  );
  it("does not elevate Railway's prose-derived authorization code", async () => {
    const error = new RailwayGraphQLError({
      message: "Not Authorized",
      status: 200,
      errors: [{ message: "Not Authorized", extensions: { code: "UNAUTHORIZED" } }],
    });
    vi.spyOn(Sandbox, "create").mockRejectedValue(error);
    const provider = new RailwaySandboxProvider({ token: "key", environmentId: "test" });
    await expect(provider.provision(request, context)).rejects.toBe(error);
  });
  it.each([false, true])("CreateOS 402 on reconnect=%s", async (reconnect) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "fail",
            data: { code: "insufficient_credit", error: "fake-private-body" },
          }),
          { status: 402 },
        ),
    );
    const provider = new CreateOSSandboxProvider({ apiKey: "key", fetch });
    await accountRefusal(
      provider.provision(
        {
          ...request,
          ...(reconnect ? { providerRef: "existing", providerKind: "createos" as const } : {}),
        },
        context,
      ),
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([403, 429, 500])("preserves CreateOS non-account HTTP %s", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: "fail", data: { code: "resource_forbidden" } }), {
          status,
        }),
    );
    const provider = new CreateOSSandboxProvider({ apiKey: "key", fetch });
    await expect(provider.provision(request, context)).rejects.toBeInstanceOf(CreateOSHttpError);
  });
});
