// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited product providers are preserved. Locale initialization is shared separately.

import { useLingui } from "@lingui/react/macro";
import { InputRevealLabelsProvider } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { LocaleProvider } from "./LocaleProvider";
import { MarkdownChrome } from "./markdown-copy";

export function I18nBootstrap({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider>
      <KitLabels>
        <MarkdownChrome>{children}</MarkdownChrome>
      </KitLabels>
    </LocaleProvider>
  );
}

/** Translations for the text the UI kit draws itself. */
function KitLabels({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <InputRevealLabelsProvider show={t`Show password`} hide={t`Hide password`}>
      {children}
    </InputRevealLabelsProvider>
  );
}
