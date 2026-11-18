// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import { Button } from "@orkbot/ui-web";
import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { peekInitialBootstrap } from "../lib/bootstrap";
import { modelSetupDeferred } from "../lib/model-setup-preference";
import { captureRpcContext, SPACE_SELECTED_EVENT } from "../lib/rpc";
import { PageLoading } from "./PageLoading";

/** Check the selected workspace before opening any application screen. */
export function ModelSetupGate() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<"loading" | "open" | "setup" | "error">("loading");

  useEffect(() => {
    const recheck = () => {
      setState("loading");
      setRevision((value) => value + 1);
    };
    window.addEventListener(SPACE_SELECTED_EVENT, recheck);
    return () => window.removeEventListener(SPACE_SELECTED_EVENT, recheck);
  }, []);

  useEffect(() => {
    let active = true;
    const context = captureRpcContext();
    setState("loading");
    // Startup already requested this identity with the shell bootstrap. Later workspace
    // changes and retries must read the current scope instead of reusing that first result.
    const primed = revision === 0 ? peekInitialBootstrap() : undefined;
    const me = primed
      ? primed.then(
          (bootstrap) => bootstrap.me,
          () => context.client.me(),
        )
      : context.client.me();
    void me
      .then(async (identity) => {
        if (!active || !context.isCurrent()) return;
        let needsSetup = identity.managedModelSetupRequired;
        if (needsSetup === undefined) {
          // Older deployments still carry the managed setup decision on this RPC.
          const policy = await context.client.models.workspacePolicy();
          needsSetup =
            policy.managed && (policy.modelSetupMode === "pending" || identity.needsModel);
        }
        if (active && context.isCurrent())
          setState(needsSetup && !modelSetupDeferred(identity) ? "setup" : "open");
      })
      .catch(() => {
        if (active && context.isCurrent()) setState("error");
      });
    return () => {
      active = false;
    };
  }, [revision]);

  if (state === "loading") return <PageLoading />;
  if (state === "setup") return <Navigate to="/onboarding/model" replace />;
  if (state === "error")
    return (
      <div className="grid h-full place-content-center gap-3 text-center">
        <p>
          <Trans>Could not load model settings</Trans>
        </p>
        <Button onClick={() => setRevision((value) => value + 1)}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  return <Outlet />;
}
