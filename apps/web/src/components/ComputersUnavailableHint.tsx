// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerCapabilities, ComputerStatus, Me } from "@orkbot/contracts";
import { computerCapabilitiesFor } from "@orkbot/core";
import { Button, Spinner } from "@orkbot/ui-web";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SandboxAvailabilityPhase } from "../lib/computer-sandbox";
import {
  computersAreUnavailable,
  refreshSandboxFromServer,
  sandboxCheckFailureMessage,
} from "../lib/computer-sandbox";
import { captureRpcContext } from "../lib/rpc";
import { SuccessPop } from "./ai/primitives";

export { computersAreUnavailable } from "../lib/computer-sandbox";

type ComputersUnavailableHintProps = {
  botId?: string;
  className?: string;
  computerCapabilities?: ComputerCapabilities | null;
  onOpenComputerSettings?: () => void;
  onRecovered?: (me: Me, computer?: ComputerStatus) => void;
  onRecoveryDismissed?: () => void;
  showRetry?: boolean;
};

export function ComputersUnavailableHint({
  className,
  botId,
  computerCapabilities,
  onOpenComputerSettings,
  onRecovered,
  onRecoveryDismissed,
  showRetry = true,
}: ComputersUnavailableHintProps) {
  const { t } = useLingui();
  const [capabilities, setCapabilities] = useState(computerCapabilities);
  const [phase, setPhase] = useState<SandboxAvailabilityPhase>("idle");
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const lifetime = useRef(0);
  const previousBotId = useRef(botId);
  const onRecoveryDismissedRef = useRef(onRecoveryDismissed);
  onRecoveryDismissedRef.current = onRecoveryDismissed;
  useLayoutEffect(
    () => () => {
      lifetime.current++;
    },
    [],
  );
  useLayoutEffect(() => {
    const sameBot = previousBotId.current === botId;
    previousBotId.current = botId;
    setCapabilities(computerCapabilities);
    lifetime.current++;
    setPhase((previous) =>
      sameBot && previous === "recovered" && computerCapabilities?.start ? previous : "idle",
    );
  }, [computerCapabilities, botId]);
  useEffect(() => {
    if (phase !== "recovered") return;
    const origin = captureRpcContext();
    const timer = window.setTimeout(() => {
      if (!origin.isCurrent()) return;
      onRecoveryDismissedRef.current?.();
      setPhase("idle");
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [phase, botId]);

  async function handleCheckAgain() {
    if (phase === "loading") return;
    const origin = captureRpcContext();
    const generation = lifetime.current;
    const isCurrent = () => generation === lifetime.current && origin.isCurrent();
    setPhase("loading");
    setFailureMessage(null);
    try {
      const [me, computer] = await Promise.all([
        refreshSandboxFromServer(origin),
        botId ? origin.client.computer.status({ botId }) : undefined,
      ]);
      if (!isCurrent()) return;
      const checked = computer ? computerCapabilitiesFor(computer) : me.computerCapabilities;
      setCapabilities(checked);
      setPhase(computersAreUnavailable(checked) ? "unavailable" : "recovered");
      onRecovered?.(me, computer);
    } catch (error) {
      if (!isCurrent()) return;
      setPhase("failure");
      setFailureMessage(sandboxCheckFailureMessage(error));
      setCapabilities(null);
    }
  }

  return (
    <div
      data-testid="computers-unavailable-hint"
      className={className}
      role={phase === "failure" ? "alert" : undefined}
    >
      {phase === "loading" ? (
        <Spinner className="text-muted-foreground" aria-label={t`Checking computer setup…`} />
      ) : null}
      {phase === "recovered" ? (
        <SuccessPop label={t`Computers are available. Reload or open a bot to continue.`} />
      ) : phase !== "loading" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {failureMessage ?? t`Computers unavailable`}
        </p>
      ) : null}
      {showRetry && (computersAreUnavailable(capabilities) || phase === "failure") ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={phase === "loading"}
            onClick={() => void handleCheckAgain()}
          >
            {phase === "loading" ? <Trans>Checking…</Trans> : <Trans>Check again</Trans>}
          </Button>
          {onOpenComputerSettings ? (
            <Button type="button" variant="outline" size="sm" onClick={onOpenComputerSettings}>
              <Trans>Open computer settings</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
