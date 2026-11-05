// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0

import type { RouterContext } from "#modules/platform/routes/context";
import {
  getAccountComputerSettings,
  getComputerProviderSettings,
  updateAccountComputerSettings,
  updateComputerProviderSettings,
} from "../computer-provider-config.js";

export function computerProviderRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    computerProvider: {
      get: authed.computerProvider.get.handler(({ context }) =>
        getComputerProviderSettings(deps, context.actor),
      ),
      update: authed.computerProvider.update.handler(({ context, input }) =>
        updateComputerProviderSettings(deps, context.actor, input),
      ),
      account: {
        get: authed.computerProvider.account.get.handler(({ context }) =>
          getAccountComputerSettings(deps, context.actor),
        ),
        update: authed.computerProvider.account.update.handler(({ context, input }) =>
          updateAccountComputerSettings(deps, context.actor, input),
        ),
      },
    },
  };
}
