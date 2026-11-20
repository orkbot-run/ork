import type { ProcessEvent } from "@orkbot/adapter-kit";
import type { HostComputerEnvironment, HostComputerRequest } from "./host-computer-protocol.js";
import type { HostScreenObservation } from "./host-screen.js";
import type { UserDevice, UserDeviceGateway } from "./user-device-protocol.js";

export const USER_DEVICE_EMULATOR_OUTPUT = "fixture-mac\n";

/**
 * Deterministic, offline stand-in for a connected desktop: every user has one, every command
 * prints USER_DEVICE_EMULATOR_OUTPUT, and every app shows one empty window. Records what it was
 * asked to run.
 */
export class UserDeviceEmulator implements UserDeviceGateway {
  readonly requests: Array<{ userId: string; request: HostComputerRequest }> = [];

  async connected(_userId: string, deviceId?: string): Promise<UserDevice | null> {
    if (deviceId !== undefined && deviceId !== "emulated-device") return null;
    return { deviceId: "emulated-device", name: "Fixture Mac", platform: "darwin" };
  }

  async pairedSince(userId: string, deviceId?: string): Promise<Date | null> {
    return (await this.connected(userId, deviceId)) ? new Date(0) : null;
  }

  async list(userId: string) {
    const device = await this.connected(userId);
    return device ? [{ ...device, connected: true, defaultForBots: true }] : [];
  }

  async *request<T>(
    userId: string,
    request: HostComputerRequest,
    _signal: AbortSignal,
    deviceId?: string,
  ): AsyncIterable<T> {
    if (!(await this.connected(userId, deviceId))) throw new Error("Computer is offline");
    this.requests.push({ userId, request });
    if (request.method === "capabilities") {
      yield { screen: true, control: true } as T;
      return;
    }
    if (request.method === "environment") {
      const environment: HostComputerEnvironment = {
        platform: "darwin",
        home: "/Users/fixture",
        shell: "/bin/zsh",
      };
      yield environment as T;
      return;
    }
    if (request.method === "execute") {
      const events: ProcessEvent[] = [
        { type: "stdout", data: USER_DEVICE_EMULATOR_OUTPUT },
        { type: "exit", code: 0 },
      ];
      for (const event of events) yield event as T;
      return;
    }
    if (request.method === "screenObserve" || request.method === "screenAct") {
      const observation: HostScreenObservation = {
        app: request.app,
        title: "Untitled",
        tree: '- [0] AXWindow "Untitled"\n  - [1] AXTextArea',
      };
      yield (
        request.method === "screenAct"
          ? { completed: request.actions.length, observation }
          : observation
      ) as T;
      return;
    }
    yield null as T;
  }
}
