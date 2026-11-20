// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata, VaultKind, VaultRevealed } from "@orkbot/contracts";
import { isIdentityConfirmationRequired, VAULT_KINDS, vaultKind } from "@orkbot/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ListSearchInput,
  Switch,
} from "@orkbot/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useIdentityConfirmation } from "../components/ConfirmIdentityDialog";
import { useVaultKindLabels, useVaultSubtitle, VaultTile } from "../components/vault/kinds";
import { VaultItemDetail } from "../components/vault/VaultItemDetail";
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
  const [opened, setOpened] = useState<string | null>(null);
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<{ kind: VaultKind; initial?: VaultEditorInitial } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();
  const { one, many } = useVaultKindLabels();
  const subtitle = useVaultSubtitle();
  const spaces = useQuery({
    ...queries.organizationVault.credentialWorkspaces.queryOptions({
      input: { name: opened ?? "" },
    }),
    queryFn: () => rpc.organizationVault.credentialWorkspaces({ name: opened! }),
    enabled: shared && opened !== null,
  });
  useEffect(() => {
    setOpened(null);
    setEditing(null);
    setBusy(false);
    setError(null);
  }, [owner]);
  const contacts = (items.data ?? []).flatMap((item) =>
    item.auth?.type === "contact" ? [{ name: item.name, title: item.title }] : [],
  );
  const openedItem = items.data?.find((item) => item.name === opened);
  const counts = new Map<VaultKind, number>();
  for (const item of items.data ?? [])
    if (item.auth)
      counts.set(vaultKind(item.auth.type), (counts.get(vaultKind(item.auth.type)) ?? 0) + 1);
  const kindsShown = VAULT_KINDS.filter((kind) => counts.has(kind));
  const activeFilter = filter !== "all" && counts.has(filter) ? filter : "all";
  const searching = (items.data?.length ?? 0) >= 8;
  const needle = searching ? search.trim().toLowerCase() : "";
  const shown = (items.data ?? []).filter(
    (item) =>
      (activeFilter === "all" || (item.auth && vaultKind(item.auth.type) === activeFilter)) &&
      (!needle ||
        [item.title, subtitle(item), item.origin, item.name].some((value) =>
          value.toLowerCase().includes(needle),
        )),
  );

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
        contacts={contacts}
        heading={editing.initial ? t`Edit organization secret` : t`Add organization secret`}
        onBack={() => setEditing(null)}
        failureText={() => t`Could not save the secret. Please try again.`}
        onSave={async (result) => {
          if (!result.value && !editing.initial) throw new Error("A value is required");
          await rpc.organizationVault.put({
            destination: {
              ...result.destination,
              name: result.destination.name ?? `secret-${crypto.randomUUID()}`,
            },
            value: result.value,
            title: result.title,
            note: result.note,
            createOnly: !editing.initial,
          });
          await items.refetch();
        }}
      />
    );

  function startEdit(item: BotSecretMetadata, revealed?: VaultRevealed) {
    if (!item.auth) return;
    setEditing({
      kind: vaultKind(item.auth.type),
      initial: {
        name: item.name,
        title: item.title,
        note: item.note,
        origin: item.origin,
        auth: item.auth,
        ...(revealed && "fields" in revealed ? { loginFields: revealed.fields } : {}),
        ...(revealed && "card" in revealed ? { card: revealed.card } : {}),
        ...(item.preview?.contact ? { contact: item.preview.contact } : {}),
      },
    });
  }

  if (openedItem)
    return (
      <section data-testid="organization-vault" className="space-y-6">
        <VaultItemDetail
          item={openedItem}
          contactTitles={new Map(contacts.map((contact) => [contact.name, contact.title]))}
          busy={busy}
          error={error}
          onClose={() => {
            setOpened(null);
            setError(null);
          }}
          onReveal={async () => {
            try {
              const value = await withIdentityConfirmation(() =>
                rpc.organizationVault.reveal({ name: openedItem.name }),
              );
              return owner.isCurrent() ? value : null;
            } catch (err) {
              if (owner.isCurrent() && !isIdentityConfirmationRequired(err))
                setError(t`Could not open the secret.`);
              return null;
            }
          }}
          onEdit={(revealed) => startEdit(openedItem, revealed)}
          onRemove={async () => {
            setBusy(true);
            setError(null);
            try {
              await rpc.organizationVault.remove({ name: openedItem.name });
              await items.refetch();
              setOpened(null);
              return true;
            } catch {
              setError(t`Could not remove the secret.`);
              return false;
            } finally {
              if (owner.isCurrent()) setBusy(false);
            }
          }}
        />
        <div className="space-y-3">
          <h3 className="text-sm font-medium">
            <Trans>Workspace access</Trans>
          </h3>
          <p className="text-sm text-muted-foreground">
            <Trans>Choose which workspaces can use this secret.</Trans>
          </p>
          {spaces.isError ? (
            <p role="alert" className="text-sm text-destructive">
              <Trans>Could not load workspace access.</Trans>
            </p>
          ) : null}
          {spaces.data?.map((space) => (
            <div
              key={space.id}
              className="flex min-h-11 items-center justify-between gap-3 border-t border-border py-2"
            >
              <span className="text-sm">{space.name}</span>
              <Switch
                aria-label={t`Allow ${space.name} to use this secret`}
                checked={space.granted}
                disabled={busy}
                onCheckedChange={async (allowed) => {
                  setBusy(true);
                  setError(null);
                  try {
                    await rpc.organizationVault.setCredentialWorkspaceAccess({
                      name: openedItem.name,
                      spaceId: space.id,
                      allowed,
                    });
                    await spaces.refetch();
                  } catch {
                    if (owner.isCurrent()) setError(t`Could not change workspace access.`);
                  } finally {
                    if (owner.isCurrent()) setBusy(false);
                  }
                }}
              />
            </div>
          ))}
        </div>
        {identityDialog}
      </section>
    );

  return (
    <section data-testid="organization-vault" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Your organization's server manages these secrets. Ork Accounts does not receive them. Only
          organization admins can manage this vault.
        </Trans>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {kindsShown.length > 1 ? (
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0" aria-label={t`Show`}>
            {(["all", ...kindsShown] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={activeFilter === kind}
                className="rounded-full text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
                onClick={() => setFilter(kind)}
              >
                {kind === "all" ? t`All` : many[kind]}{" "}
                <span className="text-faint-foreground tabular-nums">
                  {kind === "all" ? items.data?.length : counts.get(kind)}
                </span>
              </Button>
            ))}
          </fieldset>
        ) : null}
        <span className="flex-1" />
        {searching ? (
          <div className="w-44">
            <ListSearchInput
              query={search}
              setQuery={setSearch}
              label={t`Search Vault`}
              placeholder={t`Search`}
            />
          </div>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="vault-new"
            disabled={busy || !items.isSuccess}
            render={<Button size="sm" className="rounded-full" />}
          >
            <Plus />
            <Trans>New</Trans>
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {VAULT_KINDS.map((kind) => (
              <Fragment key={kind}>
                {kind === "api_key" ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setEditing({ kind })}>
                  <VaultTile kind={kind} title="" className="size-5 rounded-none bg-transparent" />
                  {one[kind]}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {items.isError ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not load credentials.</Trans>
        </p>
      ) : null}
      {shown.length ? (
        <ul data-testid="vault-card" className="overflow-hidden rounded-xl bg-muted/50">
          {shown.map((item) => (
            <li key={item.name} className="border-t border-border first:border-t-0">
              <button
                type="button"
                data-testid="vault-credential-row"
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => {
                  setError(null);
                  setOpened(item.name);
                }}
              >
                <VaultTile kind={item.auth ? vaultKind(item.auth.type) : null} title={item.title} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">
                    {item.title || item.name}
                  </span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">
                    {item.auth
                      ? subtitle(item)
                      : t`These saved settings can't be read. Remove it and add it again.`}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint-foreground rtl:rotate-180" />
              </button>
            </li>
          ))}
        </ul>
      ) : needle && items.data?.length ? (
        <p className="py-6 text-center text-[13px] text-muted-foreground">
          <Trans>No matches</Trans>
        </p>
      ) : items.isSuccess && !items.data?.length ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing saved yet.</Trans>
        </p>
      ) : null}
      {identityDialog}
    </section>
  );
}
