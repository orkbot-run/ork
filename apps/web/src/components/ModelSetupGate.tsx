// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import { Button } from "@orkbot/ui-web";
import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
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
    void Promise.all([context.client.me(), context.client.models.workspacePolicy()])
      .then(([me, policy]) => {
        if (active && context.isCurrent())
          setState(
            policy.managed && (policy.modelSetupMode === "pending" || me.needsModel)
              ? "setup"
              : "open",
          );
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
