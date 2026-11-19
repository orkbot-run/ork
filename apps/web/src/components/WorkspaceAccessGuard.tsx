// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans } from "@lingui/react/macro";
import { Button } from "@orkbot/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import {
  captureRpcContext,
  forgetSelectedSpace,
  SPACE_UNAVAILABLE_NOTICE_KEY,
  selectedSpaceId,
} from "../lib/rpc";

const CHECK_INTERVAL_MS = 15_000;

/** Retire the whole product view when Accounts confirms the desktop session lost access. */
export function WorkspaceAccessGuard({ children }: { children: ReactNode }) {
  const [openingFailed, setOpeningFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(() => {
    try {
      const saved = window.sessionStorage.getItem(SPACE_UNAVAILABLE_NOTICE_KEY) === "1";
      window.sessionStorage.removeItem(SPACE_UNAVAILABLE_NOTICE_KEY);
      return saved;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const check = desktopBridge()?.accounts?.workspaceAccess;
    if (!check) return;
    let active = true;
    let pending = false;
    let denied = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retire = () => {
      forgetSelectedSpace();
      denied = true;
      setUnavailable(true);
    };
    const verify = async () => {
      if (!active || pending || denied || document.visibilityState === "hidden") return;
      pending = true;
      const selected = selectedSpaceId();
      const context = captureRpcContext(null);
      try {
        const allowed = await check();
        if (!active) return;
        if (allowed === false) {
          retire();
          return;
        }
        if (allowed && selected) {
          const { organizations } = await context.client.organizations.list();
          if (
            active &&
            context.isCurrent() &&
            selectedSpaceId() === selected &&
            !organizations.some((organization) => organization.spaceIds.includes(selected))
          ) {
            retire();
          }
        }
      } catch {
        // A network or authentication outage does not prove that access was removed.
      } finally {
        pending = false;
        if (active && !denied) timer = setTimeout(() => void verify(), CHECK_INTERVAL_MS);
      }
    };
    const resume = () => {
      if (document.visibilityState === "hidden") return;
      if (timer) clearTimeout(timer);
      void verify();
    };
    void verify();
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  if (!unavailable) return children;
  return (
    <main className="flex h-full items-center justify-center bg-background p-6">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workspace-unavailable-title"
        aria-describedby="workspace-unavailable-description"
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-lg"
      >
        <h1 id="workspace-unavailable-title" className="text-xl font-semibold">
          <Trans>Workspace unavailable</Trans>
        </h1>
        <p id="workspace-unavailable-description" className="text-muted-foreground">
          <Trans>This workspace was closed or your access was removed.</Trans>
        </p>
        {openingFailed && (
          <p role="alert">
            <Trans>Could not open the workspace picker. Try again.</Trans>
          </p>
        )}
        <Button
          autoFocus
          onClick={() => {
            setOpeningFailed(false);
            void desktopBridge()
              ?.server?.change()
              .catch(() => setOpeningFailed(true));
          }}
        >
          <Trans>Choose workspace</Trans>
        </Button>
      </div>
    </main>
  );
}
