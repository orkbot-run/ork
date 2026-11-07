// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { describe, expect, it, vi } from "vitest";
import { inspectComputerCapabilities } from "./computer-capabilities.js";
import type { SandboxProvider } from "./interfaces.js";

function provider(input: {
  graphical: boolean;
  pty: boolean;
  takeover: boolean;
  provisioning?: boolean;
}) {
  return {
    describe: () => ({ capabilities: input }),
    provision: vi.fn(() => {
      throw new Error("must not provision");
    }),
    connectScreen: vi.fn(() => {
      throw new Error("must not connect");
    }),
  } as unknown as SandboxProvider;
}

describe("computer capability projection", () => {
  it("does not turn a PTY capability into a browser terminal without an implementation", async () => {
    const sandbox = provider({ graphical: false, pty: true, takeover: false });
    expect(await inspectComputerCapabilities(sandbox)).toEqual({
      start: true,
      screen: false,
      control: false,
      terminal: false,
    });
    expect(sandbox.provision).not.toHaveBeenCalled();
    expect(sandbox.connectScreen).not.toHaveBeenCalled();
  });

  it("preserves an explicitly disabled target and requires graphics for control", async () => {
    expect(
      await inspectComputerCapabilities(
        provider({ provisioning: false, graphical: false, pty: false, takeover: true }),
      ),
    ).toEqual({ start: false, screen: false, control: false, terminal: false });
  });
});
