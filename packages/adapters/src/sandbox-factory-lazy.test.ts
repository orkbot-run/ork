// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited lazy-provider checks are retained. Complete provider-boundary coverage is an Ork addition.

import { beforeEach, describe, expect, it, vi } from "vitest";

const evaluated = vi.hoisted(() => ({ provider: vi.fn(), sdk: vi.fn() }));

vi.mock("./boat-sandbox.js", async (original) => {
  evaluated.provider("boat");
  return original();
});
vi.mock("./boxd-sandbox.js", async (original) => {
  evaluated.provider("boxd");
  return original();
});
vi.mock("./daytona-sandbox.js", async (original) => {
  evaluated.provider("daytona");
  return original();
});
vi.mock("./createos-sandbox.js", async (original) => {
  evaluated.provider("createos");
  return original();
});
vi.mock("./e2b-sandbox.js", async (original) => {
  evaluated.provider("e2b");
  return original();
});
vi.mock("./novita-sandbox.js", async (original) => {
  evaluated.provider("novita");
  return original();
});
vi.mock("./railway-sandbox.js", async (original) => {
  evaluated.provider("railway");
  return original();
});
vi.mock("./kubernetes-sandbox.js", async (original) => {
  evaluated.provider("kubernetes");
  return original();
});
vi.mock("./incus-sandbox.js", async (original) => {
  evaluated.provider("incus");
  return original();
});
vi.mock("./wuying-sandbox.js", async (original) => {
  evaluated.provider("wuying");
  return original();
});

// Fail on module evaluation, rather than merely checking which provider was returned.
vi.mock("@boatdev/sdk", () => {
  evaluated.sdk("boat");
  throw new Error("Boat SDK evaluated");
});
vi.mock("@boxd-sh/sdk", () => {
  evaluated.sdk("boxd");
  throw new Error("Boxd SDK evaluated");
});
vi.mock("@daytona/sdk", () => {
  evaluated.sdk("daytona");
  throw new Error("Daytona SDK evaluated");
});
vi.mock("@e2b/desktop", () => {
  evaluated.sdk("e2b");
  throw new Error("E2B SDK evaluated");
});
vi.mock("novita-sandbox", () => {
  evaluated.sdk("novita");
  throw new Error("Novita SDK evaluated");
});
vi.mock("@kubernetes/client-node", () => {
  evaluated.sdk("kubernetes");
  throw new Error("Kubernetes SDK evaluated");
});
vi.mock("@alicloud/ecd20200930", () => {
  evaluated.sdk("wuying");
  throw new Error("ECD loaded on default path");
});
vi.mock("@alicloud/appstream-center20210218", () => {
  throw new Error("Appstream loaded on default path");
});
vi.mock("@alicloud/openapi-core", () => {
  throw new Error("OpenAPI loaded on default path");
});
vi.mock("@darabonba/typescript", () => {
  throw new Error("Darabonba loaded on default path");
});
vi.mock("railway", () => {
  evaluated.sdk("railway");
  throw new Error("Railway SDK loaded on default path");
});

import * as adapters from "./index.js";
import type { SandboxProviderOptions } from "./sandbox-factory.js";
import { createSandboxProvider } from "./sandbox-factory.js";

const credentials: SandboxProviderOptions = {
  boatApiKey: "fake-boat-key",
  boxdApiKey: "fake-boxd-key",
  daytonaApiKey: "fake-daytona-key",
  createosApiKey: "fake-createos-key",
  e2bApiKey: "fake-e2b-key",
  novitaApiKey: "fake-novita-key",
  railwayApiToken: "fake-railway-token",
  railwayEnvironmentId: "fake-environment",
  incusUrl: "https://incus.example.test:8443",
  incusClientCert: "fake-certificate",
  incusClientKey: "fake-private-key",
  wuyingAccessKeyId: "fake-key",
  wuyingAccessKeySecret: "fake-secret",
  wuyingDesktopId: "ecd-fake",
  wuyingEndUserId: "fake-user",
  wuyingMcpUrl: "https://gateway.example.test/mcp",
  wuyingMcpToken: "fake-token",
};
const context = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

describe("optional provider loading", () => {
  // Imports happen before the first test. Never clear these spies before asserting the default graph.
  it("never evaluates optional providers or SDKs through the adapters barrel and default factories", async () => {
    for (const kind of ["", "none", "docker", "fake"]) {
      const expected = kind || "none";
      expect((await createSandboxProvider(kind, credentials)).describe().id).toBe(expected);
      expect((await adapters.createRunSandbox(kind, credentials)).describe().id).toBe(expected);
    }
    expect(evaluated.provider).not.toHaveBeenCalled();
    expect(evaluated.sdk).not.toHaveBeenCalled();
  });

  it("keeps the adapters barrel from exposing optional provider constructors", () => {
    for (const name of [
      "BoatSandboxProvider",
      "BoxdSandboxProvider",
      "DaytonaSandboxProvider",
      "CreateOSSandboxProvider",
      "E2BSandboxProvider",
      "NovitaSandboxProvider",
      "RailwaySandboxProvider",
      "KubernetesSandboxProvider",
      "IncusSandboxProvider",
      "WuyingSandboxProvider",
    ])
      expect(adapters).not.toHaveProperty(name);
  });

  it("rejects missing, whitespace and incomplete credentials before evaluating provider modules", async () => {
    for (const kind of [
      "boat",
      "boxd",
      "daytona",
      "createos",
      "e2b",
      "novita",
      "railway",
      "incus",
      "wuying",
    ]) {
      expect((await createSandboxProvider(kind, {})).describe().id).toBe("none");
      expect(
        (
          await createSandboxProvider(
            kind,
            Object.fromEntries(Object.keys(credentials).map((key) => [key, " \t "])),
          )
        ).describe().id,
      ).toBe("none");
    }
    for (const key of [
      "railwayApiToken",
      "railwayEnvironmentId",
      "incusUrl",
      "incusClientCert",
      "incusClientKey",
      "wuyingAccessKeyId",
      "wuyingAccessKeySecret",
      "wuyingDesktopId",
      "wuyingEndUserId",
      "wuyingMcpUrl",
      "wuyingMcpToken",
    ] as const) {
      const kind = key.startsWith("railway")
        ? "railway"
        : key.startsWith("incus")
          ? "incus"
          : "wuying";
      expect(
        (await createSandboxProvider(kind, { ...credentials, [key]: " " })).describe().id,
      ).toBe("none");
    }
    await expect(createSandboxProvider("not-a-provider", credentials)).rejects.toThrow(
      "Unknown SANDBOX_PROVIDER",
    );
    expect(evaluated.provider).not.toHaveBeenCalled();
    expect(evaluated.sdk).not.toHaveBeenCalled();
  });

  describe("explicit configured providers", () => {
    beforeEach(() => {
      evaluated.provider.mockClear();
      evaluated.sdk.mockClear();
    });

    it.each(["boat", "boxd", "daytona"])(
      "loads the %s SDK only when that configured provider is selected",
      async (kind) => {
        await expect(createSandboxProvider(kind, credentials)).rejects.toThrow();
        expect(evaluated.provider.mock.calls.map(([provider]) => provider)).toEqual([kind]);
        expect(evaluated.sdk.mock.calls.map(([provider]) => provider)).toEqual([kind]);
      },
    );

    it.each(["e2b", "novita", "railway", "kubernetes", "wuying"])(
      "defers the configured %s SDK until its first computer operation",
      async (kind) => {
        const provider = await createSandboxProvider(kind, credentials);
        expect(provider.describe().id).toBe(kind);
        expect(evaluated.provider.mock.calls.map(([provider]) => provider)).toEqual([kind]);
        expect(evaluated.sdk).not.toHaveBeenCalled();
        await expect(
          provider.provision({ botId: "bot", homePath: "/unused" }, context),
        ).rejects.toThrow();
        expect(evaluated.sdk.mock.calls.map(([provider]) => provider)).toContain(kind);
      },
    );

    it.each(["createos", "incus"])(
      "loads the configured %s provider without loading unrelated SDKs",
      async (kind) => {
        const provider = await createSandboxProvider(kind, credentials);
        expect(provider.describe().id).toBe(kind);
        expect(evaluated.provider.mock.calls.map(([provider]) => provider)).toEqual([kind]);
        expect(evaluated.sdk).not.toHaveBeenCalled();
      },
    );
  });
});
