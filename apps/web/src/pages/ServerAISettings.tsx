// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { RpcInput, RpcOutput } from "@orkbot/contracts";
import { workspaceAIUpdate } from "@orkbot/core";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Label,
  Spinner,
  Switch,
} from "@orkbot/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { captureRpcContext } from "../lib/rpc";
import { useBoundSpaceId, useSpaceRpc } from "../lib/space-rpc";
import { ServerAIAccountForm } from "./model-settings/server-ai-account-form";
import {
  WorkspaceAIAccountForm,
  WorkspaceAIBudgetForm,
} from "./model-settings/workspace-ai-account-form";

export function AISettingsFrame({
  embedded,
  onClose,
  children,
}: {
  embedded?: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  if (embedded) return <div data-testid="model-settings">{children}</div>;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>
            <Trans>Models</Trans>
          </DialogTitle>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
        <div className="rk-scroll min-h-0 overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

type Assignment = RpcOutput<"serverAI/status">["connections"][number];
export function ServerAISettings({ embedded, onClose }: { embedded?: boolean; onClose(): void }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const boundSpace = useBoundSpaceId();
  const boundClient = useSpaceRpc();
  const owner = useMemo(
    () => captureRpcContext(boundSpace ?? undefined),
    [boundSpace, boundClient],
  );
  const status = useQuery({
    ...queries.serverAI.status.queryOptions(),
    queryFn: () => owner.client.serverAI.status(),
  });
  const catalog = useQuery({
    ...queries.serverAI.catalog.queryOptions(),
    queryFn: () => owner.client.serverAI.catalog(),
    enabled: status.data?.canManageServer === true,
  });
  const [adding, setAdding] = useState(false);
  const [editingAccount, setEditingAccount] = useState<string | null>(null);
  const [editingAssignment, setEditingAssignment] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    setAdding(false);
    setEditingAccount(null);
    setEditingAssignment(null);
    setBusy(false);
    setError(null);
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [owner]);
  const refresh = async () => {
    await status.refetch();
    if (owner.isCurrent())
      await queryClient.invalidateQueries({ queryKey: queries.me.queryOptions().queryKey });
  };
  async function action(work: (signal: AbortSignal) => Promise<unknown>) {
    if (operation.current || !owner.isCurrent()) return false;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      await work(controller.signal);
      if (owner.isCurrent() && !controller.signal.aborted) await refresh();
      return !controller.signal.aborted && owner.isCurrent();
    } catch {
      if (owner.isCurrent() && !controller.signal.aborted) setError(t`Could not save`);
      return false;
    } finally {
      if (operation.current === controller) operation.current = null;
      if (owner.isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  }
  const configure = (row: Assignment, patch: Partial<RpcInput<"serverAI/configure">>) =>
    action(async (signal) => {
      await owner.client.serverAI.configure(workspaceAIUpdate(row, patch), { signal });
    });
  const value = status.data;
  return (
    <AISettingsFrame embedded={embedded} onClose={onClose}>
      <div className="grid gap-5" data-testid={value ? "server-ai-ready" : undefined}>
        {status.isPending ? <Spinner /> : null}
        {error || status.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? t`Could not load model settings`}
          </p>
        ) : null}
        {status.isError ? (
          <Button variant="outline" onClick={() => void status.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        ) : null}
        {value?.canManageWorkspace ? (
          <WorkspaceAIBudgetForm
            key={`${value.spaceId}:${value.workspaceMonthlyBudgetMicros}`}
            budget={value.workspaceMonthlyBudgetMicros}
            busy={busy}
            onSave={(monthlyBudgetMicros) =>
              action((signal) =>
                owner.client.serverAI.workspaceBudget({ monthlyBudgetMicros }, { signal }),
              )
            }
          />
        ) : null}
        {value?.connections.map((row) => (
          <section
            className="grid gap-3 border-b border-border pb-4"
            key={row.id}
            aria-label={row.label}
          >
            <div>
              <h3 className="text-sm font-medium">{row.label}</h3>
              <p className="text-sm text-muted-foreground">
                {row.state === "active" ? (row.defaultModelId ?? row.provider) : t`Reconnect`}
              </p>
            </div>
            {value.canManageWorkspace ? (
              <div className="grid gap-3">
                <Label className="flex items-center justify-between">
                  <Trans>Enabled</Trans>
                  <Switch
                    checked={row.enabled}
                    disabled={busy || (!row.enabled && row.state !== "active")}
                    onCheckedChange={(enabled) => void configure(row, { enabled })}
                  />
                </Label>
                <Label className="flex items-center justify-between">
                  <Trans>Default</Trans>
                  <Switch
                    checked={row.enabled && row.isDefault}
                    disabled={busy || !row.enabled || row.state !== "active"}
                    onCheckedChange={(isDefault) => void configure(row, { isDefault })}
                  />
                </Label>
                <Label className="flex items-center justify-between">
                  <Trans>Fallback</Trans>
                  <Switch
                    checked={row.fallback}
                    disabled={busy || !row.enabled || row.state !== "active"}
                    onCheckedChange={(fallback) => void configure(row, { fallback })}
                  />
                </Label>
              </div>
            ) : null}
            {value.canManageWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditingAssignment(editingAssignment === row.id ? null : row.id)}
              >
                <Trans>Models and limits</Trans>
              </Button>
            ) : null}
            {editingAssignment === row.id ? (
              <WorkspaceAIAccountForm
                key={`${row.id}:${row.assignmentRevision}`}
                row={row}
                busy={busy}
                onSave={(patch) => configure(row, patch)}
                onCancel={() => setEditingAssignment(null)}
              />
            ) : null}
          </section>
        ))}
        {value && !value.connections.length ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No AI accounts assigned</Trans>
          </p>
        ) : null}
        {value?.canManageServer ? (
          <>
            <section className="grid gap-3" aria-label={t`Server accounts`}>
              <h3 className="text-sm font-medium">
                <Trans>Server accounts</Trans>
              </h3>
              {value.accounts.map((row) => (
                <div className="grid gap-2 border-b border-border pb-3" key={row.id}>
                  <span className="text-sm font-medium">{row.label}</span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !catalog.data}
                      onClick={() => {
                        setAdding(false);
                        setEditingAccount(editingAccount === row.id ? null : row.id);
                      }}
                    >
                      <Trans>Edit AI account</Trans>
                    </Button>
                    {value.connections.some((assigned) => assigned.id === row.id) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action((signal) =>
                            owner.client.serverAI.offer(
                              { spaceId: value.spaceId, connectionId: row.id, available: false },
                              { signal },
                            ),
                          )
                        }
                      >
                        <Trans>Remove from workspace</Trans>
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || row.state !== "active"}
                        onClick={() =>
                          void action((signal) =>
                            owner.client.serverAI.offer(
                              { spaceId: value.spaceId, connectionId: row.id, available: true },
                              { signal },
                            ),
                          )
                        }
                      >
                        <Trans>Make available</Trans>
                      </Button>
                    )}
                    {row.state !== "disabled" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action((signal) =>
                            owner.client.serverAI.disable({ connectionId: row.id }, { signal }),
                          )
                        }
                      >
                        <Trans>Disable account</Trans>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>
            {editingAccount && catalog.data ? (
              <ServerAIAccountForm
                key={editingAccount}
                account={value.accounts.find((row) => row.id === editingAccount)}
                catalog={catalog.data}
                client={owner.client}
                isCurrent={owner.isCurrent}
                onSaved={async () => {
                  setEditingAccount(null);
                  await refresh();
                }}
                onCancel={() => setEditingAccount(null)}
              />
            ) : null}
            {adding && catalog.data ? (
              <ServerAIAccountForm
                catalog={catalog.data}
                client={owner.client}
                isCurrent={owner.isCurrent}
                onSaved={async () => {
                  setAdding(false);
                  await refresh();
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <Button
                variant="outline"
                disabled={busy || !catalog.data}
                onClick={() => {
                  setEditingAccount(null);
                  setAdding(true);
                }}
              >
                <Trans>Add AI account</Trans>
              </Button>
            )}
            {catalog.isError ? (
              <Button variant="outline" onClick={() => void catalog.refetch()}>
                <Trans>Retry</Trans>
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </AISettingsFrame>
  );
}
