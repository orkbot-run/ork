// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ComputerCapabilityTarget, SandboxProvider } from "@orkbot/adapter-kit";
import { inspectComputerCapabilities } from "@orkbot/adapter-kit";
import { toComputerRef } from "@orkbot/adapters";
import type { ComputerCapabilities } from "@orkbot/contracts";
import type { createRepos } from "@orkbot/db";
import { computerHomeKey } from "@orkbot/db";

/** Optional diagnostics must neither start work nor make chat unavailable on a secret-store failure. */
export async function computerCapabilities(
  sandbox: SandboxProvider,
  input: ComputerCapabilityTarget,
): Promise<ComputerCapabilities> {
  try {
    return await inspectComputerCapabilities(sandbox, input);
  } catch {
    return { start: false, screen: false, control: false, terminal: false };
  }
}

export function botComputerCapabilities(
  deps: { sandbox: SandboxProvider },
  bot: Awaited<ReturnType<ReturnType<typeof createRepos>["getBot"]>>,
) {
  const mode = bot.computer?.scope === "dedicated" ? "dedicated" : "team";
  return computerCapabilities(deps.sandbox, {
    homeKey:
      bot.computer?.homeKey ??
      computerHomeKey({ mode, spaceId: bot.spaceId, userId: bot.userId, botId: bot.id }),
    ...(mode === "team" ? { ownerUserId: bot.userId } : {}),
    ...(bot.computer?.providerRef ? { computer: toComputerRef(bot.computer) } : {}),
  });
}
