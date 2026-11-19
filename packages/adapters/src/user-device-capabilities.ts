// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { UserDeviceGateway } from "./user-device-protocol.js";

/** Probe the exact paired device that will execute the call. OS names are not capabilities. */
export async function userDeviceScreenAvailable(
  devices: UserDeviceGateway,
  owner: string,
  deviceId: string,
  botId: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    let available = false;
    for await (const value of devices.request<{ screen?: boolean; control?: boolean }>(
      owner,
      { method: "capabilities", botId },
      AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      deviceId,
    )) {
      available = value?.screen === true && value?.control === true;
    }
    return available;
  } catch {
    // Older clients, missing drivers, denied permissions and disconnected devices fail closed.
    return false;
  }
}
