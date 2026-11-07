// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import type { ManagedConnectorProvider } from "@orkbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry } from "./composio-connector.js";
import { legacyConnectorId, resolveConfiguredConnector } from "./connector-resolution.js";

function provider(id: string, configured = true) {
  const sdk = vi.fn(() => {
    throw new Error("Metadata must not initialize the SDK");
  });
  const ready = vi.fn(async () => configured);
  const adapter = {
    describe: () => ({ id }),
    isConfigured: ready,
    catalog: sdk,
    begin: sdk,
    complete: sdk,
    revoke: sdk,
    listConnectedExternalIds: sdk,
    connectionReady: sdk,
  } as unknown as ManagedConnectorProvider;
  return { adapter, ready, sdk };
}
describe("configured connector resolution", () => {
  it("lists only configured ids, including a third adapter, without loading provider SDKs", async () => {
    const first = provider(legacyConnectorId());
    const third = provider("third-adapter");
    const off = provider("not-configured", false);
    const registry = new ConnectorRegistry([first.adapter, third.adapter, off.adapter]);
    expect(await registry.configuredProviders()).toEqual([
      { id: legacyConnectorId() },
      { id: "third-adapter" },
    ]);
    for (const fixture of [first, third, off]) expect(fixture.sdk).not.toHaveBeenCalled();
  });
  it("does not redirect an explicit unknown or unavailable id to a configured adapter", async () => {
    const original = provider(legacyConnectorId());
    const off = provider("off", false);
    const registry = new ConnectorRegistry([original.adapter, off.adapter]);
    expect(await resolveConfiguredConnector(registry, "unknown")).toBeUndefined();
    expect(await resolveConfiguredConnector(registry, "off")).toBeUndefined();
    expect(original.ready).not.toHaveBeenCalled();
  });
  it("keeps omitted legacy requests attached to their original owner after configuration changes", async () => {
    const original = provider(legacyConnectorId());
    const next = provider("new-first");
    const registry = new ConnectorRegistry([next.adapter, original.adapter]);
    expect(await resolveConfiguredConnector(registry)).toBe(original.adapter);
    original.ready.mockResolvedValue(false);
    expect(await resolveConfiguredConnector(registry)).toBeUndefined();
    expect(next.ready).not.toHaveBeenCalled();
  });
  it("rejects invalid and duplicate registration ids before SDK access", () => {
    const invalid = provider("not valid");
    expect(() => new ConnectorRegistry([invalid.adapter])).toThrow();
    const first = provider("same");
    const second = provider("same");
    expect(() => new ConnectorRegistry([first.adapter, second.adapter])).toThrow(
      "Duplicate connector id",
    );
    expect(invalid.sdk).not.toHaveBeenCalled();
  });
});
