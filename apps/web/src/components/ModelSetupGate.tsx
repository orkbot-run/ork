// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import type { AppBootstrap } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import { useEffect, useState } from "react";
import { Navigate, Outlet } from "react-router-dom";
import type { WorkspaceNavigationPreview } from "../lib/bootstrap";
import { peekInitialBootstrap, peekSelectedSpaceBootstrap } from "../lib/bootstrap";
import { modelSetupDeferred } from "../lib/model-setup-preference";
import { captureRpcContext, SPACE_SELECTED_EVENT } from "../lib/rpc";
import { WorkspaceOpening } from "../pages/shell/workspace-opening";
import { PageLoading } from "./PageLoading";

/** Check the selected workspace before opening any application screen. */
export function ModelSetupGate() {
  const [check, setCheck] = useState<{
    bootstrap?: Promise<AppBootstrap>;
    opening?: { spaceId: string; preview: WorkspaceNavigationPreview };
  } | null>(null);
  const [state, setState] = useState<"loading" | "open" | "setup" | "error">("loading");

  useEffect(() => {
    const recheck = () => {
      const primed = peekSelectedSpaceBootstrap();
      const me = primed?.seed?.me;
      const ready =
        me?.managedModelSetupRequired === false ||
        (me?.managedModelSetupRequired === true && modelSetupDeferred(me));
      setState(ready ? "open" : "loading");
      setCheck({
        bootstrap: primed?.promise,
        opening:
          primed?.spaceId && primed.preview
            ? { spaceId: primed.spaceId, preview: primed.preview }
            : undefined,
      });
    };
    window.addEventListener(SPACE_SELECTED_EVENT, recheck);
    return () => window.removeEventListener(SPACE_SELECTED_EVENT, recheck);
  }, []);

  useEffect(() => {
    let active = true;
    const context = captureRpcContext();
    // Startup already requested this identity with the shell bootstrap. Later workspace
    // changes and retries must read the current scope instead of reusing that first result.
    const primed = check ? check.bootstrap : peekInitialBootstrap();
    const me = primed
      ? primed.then(
          (bootstrap) => bootstrap.me,
          () => context.client.me(),
        )
      : context.client.me();
    void me
      .then(async (identity) => {
        if (!active || !context.isCurrent()) return;
        const opening = check?.opening;
        if (
          opening &&
          (identity.spaceId !== opening.spaceId || identity.userId !== opening.preview.userId)
        ) {
          setState("error");
          return;
        }
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
  }, [check]);

  if (state === "loading")
    return check?.opening ? <WorkspaceOpening {...check.opening} /> : <PageLoading />;
  if (state === "setup") return <Navigate to="/onboarding/model" replace />;
  if (state === "error")
    return (
      <div className="grid h-full place-content-center gap-3 text-center">
        <p>
          <Trans>Could not load model settings</Trans>
        </p>
        <Button
          onClick={() => {
            setState("loading");
            setCheck({});
          }}
        >
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  return <Outlet />;
}
