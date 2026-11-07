// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import { Trans } from "@lingui/react/macro";
import { Disclosure } from "@orkbot/ui-web";
import type { ReactNode } from "react";

export function CompatibleKeyField({
  required = false,
  className,
  children,
}: {
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return required ? (
    <div className={className}>
      <span>
        <Trans>API key</Trans>
      </span>
      {children}
    </div>
  ) : (
    <Disclosure className={className} summary={<Trans>API key</Trans>}>
      {children}
    </Disclosure>
  );
}
