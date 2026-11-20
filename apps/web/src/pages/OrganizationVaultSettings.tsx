// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { VaultKind } from "@orkbot/contracts";
import { isIdentityConfirmationRequired, vaultKind } from "@orkbot/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
} from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useIdentityConfirmation } from "../components/ConfirmIdentityDialog";
import type { VaultEditorInitial } from "../components/vault/VaultItemEditor";
import { VaultItemEditorPage } from "../components/vault/VaultItemEditor";
import { useSpaceQueries } from "../lib/query";
import { captureRpcContext } from "../lib/rpc";
import { useBoundSpaceId, useSpaceRpc } from "../lib/space-rpc";

export function OrganizationVaultSettings() {
  const { t } = useLingui();
  const boundSpace = useBoundSpaceId();
  const boundClient = useSpaceRpc();
  const owner = useMemo(
    () => captureRpcContext(boundSpace ?? undefined),
    [boundSpace, boundClient],
  );
  const rpc = owner.client;
  const queries = useSpaceQueries();
  const context = useQuery({
    ...queries.organizationVault.context.queryOptions(),
    queryFn: () => rpc.organizationVault.context(),
  });
  const shared = context.data?.kind === "shared";
  const items = useQuery({
    ...queries.organizationVault.list.queryOptions(),
    queryFn: () => rpc.organizationVault.list(),
    enabled: shared,
  });
  const spaces = useQuery({
    ...queries.organizationVault.workspaces.queryOptions(),
    queryFn: () => rpc.organizationVault.workspaces(),
    enabled: shared,
  });
  const [editing, setEditing] = useState<{ kind: VaultKind; initial?: VaultEditorInitial } | null>(
    null,
  );
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  useEffect(() => {
    setEditing(null);
    setRemoving(null);
    setBusy(false);
    setError(null);
  }, [owner]);
  const kinds: Array<{ kind: VaultKind; label: string }> = [
    { kind: "login", label: t`Login` },
    { kind: "api_key", label: t`API key` },
    { kind: "variable", label: t`Variable` },
    { kind: "card", label: t`Card` },
    { kind: "contact", label: t`Contact` },
  ];

  if (context.isPending)
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>Loading vault settings…</Trans>
      </p>
    );
  if (context.data?.kind === "personal" || context.data?.kind === "unmanaged")
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>
          Personal organizations use your personal vault. Open Your settings → Vault to manage your
          secrets.
        </Trans>
      </p>
    );
  if (context.isError || context.data?.kind !== "shared")
    return (
      <p role="alert" className="text-sm text-destructive">
        <Trans>Could not verify this organization. Sign in again and try again.</Trans>
      </p>
    );

  if (editing)
    return (
      <VaultItemEditorPage
        kind={editing.kind}
        mode={editing.initial ? "edit" : "new"}
        initial={editing.initial}
        contacts={(items.data ?? []).flatMap((item) =>
          item.auth?.type === "contact" ? [{ name: item.name, title: item.title }] : [],
        )}
        heading={editing.initial ? t`Edit organization secret` : t`Add organization secret`}
        onBack={() => setEditing(null)}
        failureText={() => t`Could not save the secret. Please try again.`}
        onSave={async (result) => {
          if (!result.value && !editing.initial) throw new Error("A value is required");
          const name = result.destination.name ?? `secret-${crypto.randomUUID()}`;
          await rpc.organizationVault.put({
            destination: { ...result.destination, name },
            value: result.value,
            title: result.title,
            note: result.note,
            createOnly: !editing.initial,
          });
          await items.refetch();
        }}
      />
    );

  return (
    <section className="space-y-7" data-testid="organization-vault">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Your organization's server manages these secrets. Ork Accounts does not receive them. Only
          organization admins can manage this vault.
        </Trans>
      </p>
      {(items.isError || spaces.isError) && (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not load the organization vault. Check your access and try again.</Trans>
        </p>
      )}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">
              <Trans>Secrets</Trans>
            </h3>
            <p className="text-sm text-muted-foreground">
              <Trans>Make credentials available to approved workspaces.</Trans>
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button disabled={busy || !items.isSuccess || !spaces.isSuccess}>
                  <Plus /> <Trans>Add secret</Trans> <ChevronDown />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {kinds.map(({ kind, label }) => (
                <DropdownMenuItem key={kind} onClick={() => setEditing({ kind })}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {items.isSuccess && !items.data.length && (
          <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            <Trans>No secrets added yet.</Trans>
          </p>
        )}
        {items.data?.map((item) => (
          <div
            key={item.name}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
          >
            <div className="min-w-0">
              <div className="break-words text-sm font-medium">{item.title || item.name}</div>
              <div className="break-all text-xs text-muted-foreground">
                {item.origin || item.auth?.type}
              </div>
            </div>
            {removing === item.name ? (
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await rpc.organizationVault.remove({ name: item.name });
                      await items.refetch();
                      setRemoving(null);
                    } catch {
                      setError(t`Could not remove the secret.`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Trans>Confirm removal</Trans>
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                {item.auth && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      if (!item.auth) return;
                      const kind = vaultKind(item.auth.type);
                      try {
                        setBusy(true);
                        const revealed =
                          kind === "login" || kind === "card"
                            ? await withIdentityConfirmation(() =>
                                rpc.organizationVault.reveal({ name: item.name }),
                              )
                            : undefined;
                        if (!owner.isCurrent()) return;
                        setEditing({
                          kind,
                          initial: {
                            name: item.name,
                            title: item.title,
                            note: item.note,
                            origin: item.origin,
                            auth: item.auth,
                            ...(revealed && "fields" in revealed
                              ? { loginFields: revealed.fields }
                              : {}),
                            ...(revealed && "card" in revealed ? { card: revealed.card } : {}),
                            ...(item.preview?.contact ? { contact: item.preview.contact } : {}),
                          },
                        });
                      } catch (err) {
                        if (owner.isCurrent() && !isIdentityConfirmationRequired(err))
                          setError(t`Could not open the secret.`);
                      } finally {
                        if (owner.isCurrent()) setBusy(false);
                      }
                    }}
                  >
                    <Trans>Edit</Trans>
                  </Button>
                )}
                <Button variant="outline" disabled={busy} onClick={() => setRemoving(item.name)}>
                  <Trans>Remove</Trans>
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div>
          <h3 className="font-medium">
            <Trans>Workspace access</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>
              Choose which workspaces on this server can use these secrets. New workspaces do not
              have access until you allow it.
            </Trans>
          </p>
        </div>
        {spaces.data?.map((space) => (
          <div
            key={space.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border p-4"
          >
            <div className="min-w-0">
              <div className="break-words text-sm font-medium">{space.name}</div>
              <div className="text-xs text-muted-foreground">{space.state}</div>
            </div>
            <Switch
              aria-label={t`Allow workspace access`}
              checked={space.granted}
              disabled={busy}
              onCheckedChange={async (allowed) => {
                setBusy(true);
                setError(null);
                try {
                  await rpc.organizationVault.setWorkspaceAccess({ spaceId: space.id, allowed });
                  await spaces.refetch();
                } catch {
                  setError(t`Could not change workspace access.`);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {identityDialog}
    </section>
  );
}
