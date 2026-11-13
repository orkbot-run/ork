// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useEffect } from "react";
import { currentApiBase } from "./api";
import { installationRevocationScope } from "./installation-transport";
import { currentSessionGeneration } from "./session";

export type WorkspaceNavigationReset = {
  generation: number;
  server: string;
  workspace: string;
  route: string;
};

export function captureWorkspaceNavigationReset(route: string): WorkspaceNavigationReset {
  const server = currentApiBase();
  return {
    generation: currentSessionGeneration(),
    server,
    workspace: JSON.stringify(installationRevocationScope(server) ?? null),
    route,
  };
}

function ownsCurrentWorkspace(pending: WorkspaceNavigationReset): boolean {
  return (
    pending.generation === currentSessionGeneration() &&
    pending.server === currentApiBase() &&
    pending.workspace === JSON.stringify(installationRevocationScope(currentApiBase()) ?? null)
  );
}

/** An explicit selection leaves old routes only after their replacement navigator mounts. */
export function useWorkspaceNavigationReset(
  pending: WorkspaceNavigationReset | null,
  ready: boolean,
  complete: (pending: WorkspaceNavigationReset) => void,
): boolean {
  const pathname = usePathname();
  const route = JSON.stringify([pathname, useGlobalSearchParams()]);
  const router = useRouter();
  const current =
    pending !== null &&
    ownsCurrentWorkspace(pending) &&
    (pathname === "/" || pending.route === route);
  useEffect(() => {
    if (!ready || !pending) return;
    if (!current || !ownsCurrentWorkspace(pending) || pathname === "/") {
      complete(pending);
      return;
    }
    router.dismissTo("/");
    router.replace("/");
  }, [pending, ready, current, pathname, router, complete]);
  return current;
}
