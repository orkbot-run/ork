// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { validLocalSettingsToken } from "#modules/computers/local-settings";

/** A stable account identifier must not be exposed through public sign-in discovery. */
export function managedAccountKeyForRequest(
  owner: string | undefined,
  capability: string | undefined,
  supplied: string | undefined,
): string | undefined {
  return owner && /^[a-f0-9]{64}$/.test(owner) && validLocalSettingsToken(capability, supplied)
    ? owner
    : undefined;
}
