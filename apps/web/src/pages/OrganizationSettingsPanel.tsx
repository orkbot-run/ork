// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited organization settings remain Apache-2.0. The audit menu follows LICENSE.md.

import { Trans, useLingui } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
} from "@orkbot/ui-web";
import { Ellipsis, Plus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { CreateOrganizationDialog } from "../components/CreateOrganizationDialog";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import type { Organization } from "../lib/organizations";
import { organizationsQuery, useOrganizations } from "../lib/organizations";
import { queryClient, useQueryUserId } from "../lib/query";
import { clearSpaceSelection, rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** The organization the app is showing: its name, and, for its owner, renaming and deletion. */
export function OrganizationSettingsPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { organizations, activeOrganizationId } = useOrganizations();
  const organization = organizations.find((candidate) => candidate.id === activeOrganizationId);
  if (!organization) return null;
  return (
    <OrganizationSettings
      key={organization.id}
      organization={organization}
      onBusyChange={onBusyChange}
    />
  );
}

function OrganizationSettings({
  organization,
  onBusyChange,
}: {
  organization: Organization;
  onBusyChange?: (busy: boolean) => void;
}) {
  const userId = useQueryUserId();
  const nameId = useId();
  const [draft, setDraft] = useState(organization.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    onBusyChange?.(pending);
  }, [pending, onBusyChange]);

  async function save() {
    const trimmed = draft.trim();
    if (pending) return;
    if (!trimmed || trimmed === organization.name) {
      setDraft(organization.name);
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc.organizations.rename({ organizationId: organization.id, name: trimmed });
      setDraft(trimmed);
      await queryClient.invalidateQueries({ queryKey: organizationsQuery(userId).queryKey });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-8" data-testid="organization-settings">
      <SettingsGroup>
        <SettingsRow
          label={
            organization.canManage ? (
              <label htmlFor={nameId}>
                <Trans>Name</Trans>
              </label>
            ) : (
              <Trans>Name</Trans>
            )
          }
          control={
            organization.canManage ? (
              <Input
                id={nameId}
                className="w-56"
                maxLength={60}
                value={draft}
                disabled={pending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.stopPropagation();
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setDraft(organization.name);
                    setError(null);
                  }
                }}
              />
            ) : (
              <p className="break-words text-sm">{organization.name}</p>
            )
          }
        >
          {error ? (
            <p role="alert" className="pt-2 text-[12.5px] text-destructive">
              {error}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="rounded-full" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          <Trans>Create organization</Trans>
        </Button>
      </div>
      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

export function OrganizationSettingsActions({
  allowDelete,
  disabled,
  onOpenAudit,
}: {
  allowDelete: boolean;
  disabled: boolean;
  onOpenAudit?: () => void;
}) {
  const { t } = useLingui();
  const { organizations, activeOrganizationId } = useOrganizations();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const organization = organizations.find((entry) => entry.id === activeOrganizationId);
  const deletable =
    allowDelete &&
    organization?.canManage &&
    organizations.filter((entry) => entry.canManage).length > 1
      ? organization
      : undefined;
  if (!onOpenAudit && !deletable) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Organization options`}
          disabled={disabled}
          render={<Button variant="ghost" size="icon-sm" />}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onOpenAudit ? (
            <DropdownMenuItem onClick={onOpenAudit}>
              <Trans>Activity log</Trans>
            </DropdownMenuItem>
          ) : null}
          {deletable ? (
            <DropdownMenuItem variant="destructive" onClick={() => setDeletingId(deletable.id)}>
              <Trans>Delete organization</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {deletable && deletingId === deletable.id ? (
        <DeleteOrganizationDialog
          organization={deletable}
          onCancel={() => setDeletingId(null)}
          onConfirm={async () => {
            const { activeSpaceId } = await rpc.organizations.remove({
              organizationId: deletable.id,
            });
            if (!selectSpace(activeSpaceId)) clearSpaceSelection();
            window.location.assign("/");
          }}
        />
      ) : null}
    </>
  );
}

export function DeleteOrganizationDialog({
  organization,
  onCancel,
  onConfirm,
}: {
  organization: Organization;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const confirmId = useId();
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = organization.name;
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            <Trans>Delete {organization.name}?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>This cannot be undone.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field>
          <FieldLabel htmlFor={confirmId} className="break-words">
            {t`Type ${name} to confirm`}
          </FieldLabel>
          <Input
            id={confirmId}
            value={typed}
            disabled={deleting}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-[13.5px] text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting || typed !== name}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm().catch((reason: unknown) => {
                setError(errorText(reason));
                setDeleting(false);
              });
            }}
          >
            {deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
