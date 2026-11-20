// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import { useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { rpc } from "../lib/rpc";

/** Recover an existing subscription through its portal instead of buying another plan. */
export function BillingRecovery({
  status,
  client = rpc,
}: {
  status: BillingStatus;
  client?: RpcClient;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function openPortal() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const { url } = await client.billing.portal();
      window.location.assign(url);
    } catch {
      setError(t`Could not open billing`);
    } finally {
      setPending(false);
    }
  }
  return (
    <div data-testid="billing-recovery" className="space-y-4">
      <p role="status" className="text-sm text-foreground">
        {status.state === "past_due" ? (
          status.canManage ? (
            <Trans>Payment failed. Update your payment method to resume your plan.</Trans>
          ) : (
            <Trans>Payment failed. Ask an owner to update the payment method.</Trans>
          )
        ) : status.canManage ? (
          <Trans>Manage billing to resume your plan.</Trans>
        ) : (
          <Trans>Ask an owner to resume your plan.</Trans>
        )}
      </p>
      {status.canManage && status.hasCustomer ? (
        <Button disabled={pending} onClick={() => void openPortal()}>
          {status.state === "past_due" ? (
            <Trans>Update payment method</Trans>
          ) : (
            <Trans>Manage billing</Trans>
          )}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
