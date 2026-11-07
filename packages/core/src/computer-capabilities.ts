// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerCapabilities, ComputerStatus, Me } from "@orkbot/contracts";

/** Old servers expose screen/terminal availability, but no authority to infer other capabilities. */
export function computerCapabilitiesFor(
  computer:
    | Pick<ComputerStatus, "capabilities" | "screenAvailable" | "terminalAvailable">
    | null
    | undefined,
  configured?: ComputerCapabilities | null,
): ComputerCapabilities {
  if (computer?.capabilities) return computer.capabilities;
  return {
    start: computer ? false : (configured?.start ?? false),
    screen: computer?.screenAvailable ?? configured?.screen ?? false,
    control: computer ? false : (configured?.control ?? false),
    terminal: computer?.terminalAvailable ?? configured?.terminal ?? false,
  };
}

export function canConfigureComputers(
  me: Pick<Me, "isAdmin" | "canConfigureAccountComputers">,
): boolean {
  return me.isAdmin || me.canConfigureAccountComputers === true;
}
