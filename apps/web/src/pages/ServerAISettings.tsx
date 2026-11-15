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
import { WorkspaceAIAccountForm } from "./model-settings/workspace-ai-account-form";

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
export function ServerAISettings({
  embedded,
  onboarding,
  onClose,
}: {
  embedded?: boolean;
  onboarding?: boolean;
  onClose(): void;
}) {
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
    refetchOnWindowFocus: "always",
  });
  const policy = useQuery(queries.models.workspacePolicy.queryOptions());
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
    await policy.refetch();
    if (owner.isCurrent())
      await queryClient.invalidateQueries({ queryKey: queries.me.queryOptions().queryKey });
  };
  async function action(work: (signal: AbortSignal) => Promise<unknown>, refreshOnError = false) {
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
      if (owner.isCurrent() && !controller.signal.aborted) {
        setError(t`Could not save`);
        if (refreshOnError) await status.refetch().catch(() => undefined);
      }
      return false;
    } finally {
      if (operation.current === controller) operation.current = null;
      if (owner.isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  }
  const configure = (row: Assignment, patch: Partial<RpcInput<"serverAI/configure">>) =>
    action(async (signal) => {
      await owner.client.serverAI.configure(
        {
          ...workspaceAIUpdate(row, patch),
          ...(onboarding
            ? {
                preserveBudget: true,
                expectedRevision: row.assignmentRevision,
                ...(!Object.hasOwn(patch, "isDefault") ? { preserveDefault: true } : {}),
              }
            : {}),
        },
        { signal },
      );
    }, onboarding);
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
        {value?.modelSetupMode === "pending" && !onboarding ? (
          value.canManageServer ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted-foreground">
                <Trans>Choose how people in your organization will connect models.</Trans>
              </p>
              <Button
                disabled={busy}
                onClick={() =>
                  void action((signal) =>
                    owner.client.serverAI.chooseMode({ mode: "organization" }, { signal }),
                  )
                }
              >
                <Trans>Connect organization models</Trans>
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action((signal) =>
                    owner.client.serverAI.chooseMode({ mode: "personal" }, { signal }),
                  )
                }
              >
                <Trans>Let people connect their own models</Trans>
              </Button>
              <p className="text-sm text-muted-foreground">
                <Trans>Personal models may process workspace data outside company servers.</Trans>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              <Trans>Waiting for an organization administrator to set up models.</Trans>
            </p>
          )
        ) : null}
        {value?.canManageServer &&
        !onboarding &&
        (value.modelSetupMode === "organization" || value.modelSetupMode === "personal") ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action((signal) =>
                owner.client.serverAI.chooseMode(
                  { mode: value.modelSetupMode === "organization" ? "personal" : "organization" },
                  { signal },
                ),
              )
            }
          >
            {value.modelSetupMode === "organization" ? (
              <Trans>Allow personal models</Trans>
            ) : (
              <Trans>Use organization models</Trans>
            )}
          </Button>
        ) : null}
        {value?.canManageWorkspace && !onboarding && value.workspaceMonthlyBudgetMicros !== null ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action((signal) =>
                owner.client.serverAI.workspaceBudget({ monthlyBudgetMicros: null }, { signal }),
              )
            }
          >
            <Trans>Remove existing workspace spending limits</Trans>
          </Button>
        ) : null}
        {value?.modelSetupMode !== "personal" &&
          value?.modelSetupMode !== "pending" &&
          value?.connections.map((row) => (
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
                  <Trans>Models</Trans>
                </Button>
              ) : null}
              {editingAssignment === row.id ? (
                <WorkspaceAIAccountForm
                  key={`${row.id}:${row.assignmentRevision}`}
                  row={row}
                  hideBudget
                  busy={busy}
                  onSave={(patch) => configure(row, patch)}
                  onCancel={() => setEditingAssignment(null)}
                />
              ) : null}
              {value.canManageWorkspace && !onboarding && row.monthlyBudgetMicros !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void configure(row, { monthlyBudgetMicros: null })}
                >
                  <Trans>Remove existing model spending limit</Trans>
                </Button>
              ) : null}
            </section>
          ))}
        {value && value.modelSetupMode !== "pending" && !value.connections.length ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No model connections available</Trans>
          </p>
        ) : null}
        {value?.available && !value.canManageServer && !onboarding ? (
          <p className="text-sm text-muted-foreground">
            {value.adminAccessReason === "role_unavailable" ? (
              <Trans>
                Your organization role could not be verified. Check that Accounts and this server
                are up to date.
              </Trans>
            ) : value.adminAccessReason === "unverified" ? (
              <Trans>
                Administrator access could not be verified. Sign in again or check the server
                configuration.
              </Trans>
            ) : (
              <Trans>
                Your account does not currently have permission to manage organization models.
              </Trans>
            )}
          </p>
        ) : null}
        {policy.data?.personalModelsAllowed ? (
          <p className="text-sm text-muted-foreground">
            <Trans>Your organization allows personal models.</Trans>{" "}
            <Trans>Personal models may process workspace data outside company servers.</Trans>
          </p>
        ) : null}
        {value?.canManageServer &&
        value.modelSetupMode !== "personal" &&
        value.modelSetupMode !== "pending" ? (
          <>
            <section className="grid gap-3" aria-label={t`Organization connections`}>
              <h3 className="text-sm font-medium">
                <Trans>Organization connections</Trans>
              </h3>
              {value.accounts.map((row) => (
                <div className="grid gap-2 border-b border-border pb-3" key={row.id}>
                  <span className="text-sm font-medium">{row.label}</span>
                  {!onboarding && row.monthlyBudgetMicros !== null ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void action((signal) =>
                          owner.client.serverAI.update(
                            {
                              connectionId: row.id,
                              label: row.label,
                              models: row.models,
                              concurrencyLimit: row.concurrencyLimit,
                              monthlyBudgetMicros: null,
                            },
                            { signal },
                          ),
                        )
                      }
                    >
                      <Trans>Remove existing account spending limit</Trans>
                    </Button>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {!onboarding ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy || !catalog.data}
                        onClick={() => {
                          setAdding(false);
                          setEditingAccount(editingAccount === row.id ? null : row.id);
                        }}
                      >
                        <Trans>Edit model connection</Trans>
                      </Button>
                    ) : null}
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
                        <Trans>Remove from organization</Trans>
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
                        <Trans>Make available to organization</Trans>
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
                        <Trans>Disable connection</Trans>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </section>
            {!onboarding && editingAccount && catalog.data ? (
              <ServerAIAccountForm
                key={editingAccount}
                account={value.accounts.find((row) => row.id === editingAccount)}
                hideBudget
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
                hideBudget
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
                <Trans>Add model connection</Trans>
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
