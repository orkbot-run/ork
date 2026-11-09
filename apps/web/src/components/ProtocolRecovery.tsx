// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import type { AuthCapabilities } from "@orkbot/contracts";
import { CLIENT_PROTOCOL_VERSION, CLIENT_UPDATE_REQUIRED_STATUS } from "@orkbot/contracts";
import { Button } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import {
  fetchAuthCapabilities,
  ProtocolUpdateRequired,
  resetAuthCapabilities,
} from "../lib/auth-capabilities";
import { lazyComponent } from "../lib/preload-recovery";
import { onRpcResponse } from "../lib/rpc";
import { useServerUpdates } from "../lib/server-updates";
import { DesktopUpdateSection } from "./DesktopUpdates";
import { PageLoading } from "./PageLoading";
import { ServerUpdateSection } from "./ServerUpdates";

const AuthPage = lazyComponent(() => import("../pages/Auth").then((module) => module.AuthPage));

/** Keep incompatible product screens unmounted while preserving authenticated update access. */
export function ProtocolRecovery({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    AuthCapabilities | null | "loading" | "unavailable" | "client"
  >("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let updateRequired = false;
    async function check() {
      const request = ++revision;
      resetAuthCapabilities();
      try {
        await fetchAuthCapabilities();
        if (active && request === revision)
          setState((current) => (updateRequired || current === "client" ? "client" : null));
      } catch (error) {
        if (active && request === revision) {
          if (error instanceof ProtocolUpdateRequired) updateRequired = false;
          setState((current) =>
            error instanceof ProtocolUpdateRequired
              ? error.capabilities
              : current === "loading"
                ? "unavailable"
                : current,
          );
        }
      }
    }
    void check();
    const stop = onRpcResponse((response) => {
      if (response.status === CLIENT_UPDATE_REQUIRED_STATUS) {
        updateRequired = true;
        setState((current) => (current && typeof current === "object" ? current : "client"));
        void check();
      }
    });
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void check();
    }, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
      stop();
    };
  }, [attempt]);
  if (state === "loading") return <PageLoading />;
  if (state === "client") return <ClientRecovery />;
  if (state === "unavailable")
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
        <p>
          <Trans>Could not check server compatibility.</Trans>
        </p>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          <Trans>Try again</Trans>
        </Button>
      </main>
    );
  if (!state) return children;
  return <Recovery capabilities={state} />;
}

function Recovery({ capabilities }: { capabilities: AuthCapabilities }) {
  const clientRequired = (capabilities.protocol?.min ?? 1) > CLIENT_PROTOCOL_VERSION;
  return clientRequired ? <ClientRecovery /> : <ServerRecovery />;
}

function ClientRecovery() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-lg font-medium">
        <Trans>Update required</Trans>
      </h1>
      <p>
        <Trans>Update Ork to connect to this server.</Trans>
      </p>
      <DesktopUpdateSection />
    </main>
  );
}

function ServerRecovery() {
  const session = authClient.useSession();
  if (session.isPending) return <PageLoading />;
  if (!session.data) return <AuthPage mode="in" recovery />;
  return <ServerRecoveryControls />;
}

function ServerRecoveryControls() {
  const server = useServerUpdates(true);
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-lg font-medium">
        <Trans>Update required</Trans>
      </h1>
      <p>
        <Trans>Update this server to continue.</Trans>
      </p>
      <ServerUpdateSection {...server} />
    </main>
  );
}
