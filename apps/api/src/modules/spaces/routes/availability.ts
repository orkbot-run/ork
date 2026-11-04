import type { RouterContext } from "#modules/platform/routes/context";
import { chooseForSpace, listOwnItems, setAvailability } from "../availability.js";

export function availabilityRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    availability: {
      set: authed.availability.set.handler(({ context, input }) =>
        setAvailability(deps.prisma, context.actor, input),
      ),
      items: authed.availability.items.handler(({ context }) =>
        listOwnItems(deps.prisma, context.actor),
      ),
      chooseForSpace: authed.availability.chooseForSpace.handler(async ({ context, input }) => {
        await chooseForSpace(deps.prisma, context.actor, input);
        return { ok: true as const };
      }),
    },
  };
}
