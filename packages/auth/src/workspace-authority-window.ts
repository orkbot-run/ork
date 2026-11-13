// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { WorkspaceProjection } from "@orkbot/contracts";
import { IDENTITY_ACCESS_SECONDS } from "@orkbot/contracts";

type ProjectedWorkspace = WorkspaceProjection["workspaces"][number];
interface Window {
  workspace: ProjectedWorkspace;
  deadline: number;
  requestStartedAt: number;
  workspaceExpiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
interface Watch {
  subject: string;
  revision: string;
  controller: AbortController;
}

/** Cached database rows never initialize this process-local authorization window. */
export class WorkspaceAuthorityWindow {
  private readonly windows = new Map<string, Window>();
  private readonly watches = new Map<string, Set<Watch>>();
  private latestRequest = -Infinity;
  private invalidatedAt = -Infinity;
  private readonly minimumVersions = new Map<string, number>();

  validate(projection: WorkspaceProjection, requestStartedAt: number): void {
    const now = performance.now();
    if (
      !Number.isFinite(requestStartedAt) ||
      requestStartedAt > now ||
      requestStartedAt < this.latestRequest ||
      requestStartedAt <= this.invalidatedAt
    )
      throw new Error("Stale workspace authority response");
    const lifetime = projection.expiresAt - projection.verifiedAt;
    if (lifetime <= 0 || lifetime > IDENTITY_ACCESS_SECONDS)
      throw new Error("Invalid workspace authority lifetime");
    const deadline = Math.min(
      requestStartedAt + lifetime * 1000,
      now + (projection.expiresAt * 1000 - Date.now()),
    );
    if (deadline <= now) throw new Error("Workspace authority already expired");
    const ids = new Set<string>();
    for (const workspace of projection.workspaces) {
      if (ids.has(workspace.id)) throw new Error("Duplicate workspace authority");
      ids.add(workspace.id);
      const old = this.windows.get(workspace.id);
      if (
        workspace.permissionVersion <
        (this.minimumVersions.get(workspace.id) ?? old?.workspace.permissionVersion ?? 0)
      )
        throw new Error("Workspace authority version regressed");
      if (
        new Set(workspace.members.map((member) => member.userId)).size !== workspace.members.length
      )
        throw new Error("Duplicate workspace admission");
    }
  }

  apply(projection: WorkspaceProjection, requestStartedAt: number): void {
    this.validate(projection, requestStartedAt);
    const now = performance.now();
    const deadline = Math.min(
      requestStartedAt + (projection.expiresAt - projection.verifiedAt) * 1000,
      now + (projection.expiresAt * 1000 - Date.now()),
    );
    const ids = new Set(projection.workspaces.map((workspace) => workspace.id));
    this.latestRequest = requestStartedAt;
    for (const id of this.windows.keys()) if (!ids.has(id)) this.revoke(id);
    for (const workspace of projection.workspaces) {
      const previous = this.windows.get(workspace.id);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => this.revoke(workspace.id), Math.max(0, deadline - now));
      timer.unref?.();
      this.windows.set(workspace.id, {
        workspace: structuredClone(workspace),
        deadline,
        requestStartedAt,
        workspaceExpiresAt: projection.expiresAt * 1000,
        timer,
      });
      this.minimumVersions.set(workspace.id, workspace.permissionVersion);
      for (const watch of this.watches.get(workspace.id) ?? []) {
        if (!this.permits(workspace.id, watch.subject, watch.revision))
          watch.controller.abort(new Error("Workspace access revoked"));
      }
    }
  }

  restrict(projection: WorkspaceProjection, requestStartedAt: number): string[] {
    this.validate(projection, requestStartedAt);
    this.latestRequest = requestStartedAt;
    const changed: string[] = [];
    for (const [id, current] of this.windows) {
      const next = projection.workspaces.find((workspace) => workspace.id === id);
      if (next?.state !== "ready" || next.permissionVersion > current.workspace.permissionVersion) {
        changed.push(id);
        this.revoke(id);
      }
    }
    for (const workspace of projection.workspaces)
      this.minimumVersions.set(workspace.id, workspace.permissionVersion);
    return changed;
  }

  invalidate(workspaceId: string): void {
    this.invalidatedAt = performance.now();
    this.revoke(workspaceId);
  }

  permits(workspaceId: string, subject: string, revision: string): boolean {
    const current = this.windows.get(workspaceId);
    return (
      !!current &&
      performance.now() < current.deadline &&
      Date.now() < current.workspaceExpiresAt &&
      current.workspace.state === "ready" &&
      current.workspace.members.some(
        (member) => member.userId === subject && member.accessVersion === revision,
      )
    );
  }

  workspace(workspaceId: string): ProjectedWorkspace | null {
    const current = this.windows.get(workspaceId);
    return current &&
      performance.now() < current.deadline &&
      Date.now() < current.workspaceExpiresAt
      ? structuredClone(current.workspace)
      : null;
  }

  /** A stream or running task keeps this signal for its entire lifetime. */
  watch(
    workspaceId: string,
    subject: string,
    revision: string,
  ): { signal: AbortSignal; dispose: () => void } {
    const watch: Watch = { subject, revision, controller: new AbortController() };
    if (!this.permits(workspaceId, subject, revision))
      watch.controller.abort(new Error("Workspace access unavailable"));
    const set = this.watches.get(workspaceId) ?? new Set<Watch>();
    set.add(watch);
    this.watches.set(workspaceId, set);
    const dispose = () => {
      set.delete(watch);
      if (!set.size) this.watches.delete(workspaceId);
    };
    watch.controller.signal.addEventListener("abort", dispose, { once: true });
    if (watch.controller.signal.aborted) dispose();
    return { signal: watch.controller.signal, dispose };
  }

  revoke(workspaceId: string): void {
    const current = this.windows.get(workspaceId);
    if (current) clearTimeout(current.timer);
    this.windows.delete(workspaceId);
    for (const watch of this.watches.get(workspaceId) ?? [])
      watch.controller.abort(new Error("Workspace access revoked"));
    this.watches.delete(workspaceId);
  }

  dispose(): void {
    this.invalidatedAt = performance.now();
    for (const id of this.windows.keys()) this.revoke(id);
  }
}
