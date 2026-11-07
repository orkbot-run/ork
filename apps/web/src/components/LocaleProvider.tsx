// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited locale initialization from I18nBootstrap is shared with browser callbacks.

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { bootstrapI18n, getActiveUiLocale } from "../lib/i18n";
import { resolveUiLocale } from "../lib/ui-locale";

/** Locale initialization without product-specific UI providers. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => i18n.locale === getActiveUiLocale());

  useEffect(() => {
    let cancelled = false;
    void bootstrapI18n(resolveUiLocale()).finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-orkbot-app-state="i18n-pending"
      />
    );
  }

  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
