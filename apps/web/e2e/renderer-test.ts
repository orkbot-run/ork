// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { BrowserContext } from "@playwright/test";
import { test as base } from "@playwright/test";

/** Apply the same renderer entry to manually created contexts before navigating. */
export async function useNativeRenderer(context: BrowserContext): Promise<void> {
  await context.route(/\/src\/main\.tsx(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: 'import "/src/native-app.tsx";',
    }),
  );
}

/** Exercise the native renderer directly, without changing browser entry behavior or native bridges. */
export const test = base.extend<{ rendererEntry: undefined }>({
  rendererEntry: [
    async ({ context }, use) => {
      await useNativeRenderer(context);
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
