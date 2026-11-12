// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";

/** Model controls live in the workspace dashboard; the app only shows the active policy. */
export function WorkspaceModelPolicy({
  value,
}: {
  value: { policy: { provider: string; modelId: string } | null };
}) {
  const { t } = useLingui();
  if (!value.policy) return null;
  return (
    <section className="mb-6 rounded-xl border border-border p-4" aria-label={t`Workspace model`}>
      <h3 className="text-[15px] font-medium">
        <Trans>Workspace model</Trans>
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        <Trans>Everyone in this workspace uses the model selected by the owner.</Trans>
      </p>
      <p className="mt-3 text-sm">
        <strong>{value.policy.provider}</strong> · {value.policy.modelId}
      </p>
    </section>
  );
}
