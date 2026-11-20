// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelCatalogEntry } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { modelConnectionOptions } from "@orkbot/core";
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
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
} from "@orkbot/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";

/** Shared keys are managed through the selected installation's authenticated session. */
export function WorkspaceModelPolicy({
  value,
  catalog,
  client,
  isCurrent,
  onChanged,
}: {
  value: {
    canManage: boolean;
    policy: { provider: string; modelId: string; blockedByPolicy?: boolean } | null;
  };
  catalog: ModelCatalogEntry[];
  client: RpcClient;
  isCurrent: () => boolean;
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [provider, setProvider] = useState("");
  const [choice, setChoice] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);
  const providers = [
    ...new Map(
      catalog
        .filter((entry) => entry.auth !== "oauth" && entry.protocol !== "decisions")
        .map((entry) => [entry.provider, entry]),
    ).values(),
  ];
  const options = modelConnectionOptions(
    catalog.filter((entry) => entry.auth !== "oauth" && entry.protocol !== "decisions"),
  );
  const optionKey = (option: (typeof options)[number]) =>
    option.baseUrl ? JSON.stringify([option.id, option.baseUrl]) : option.id;
  const selected = providers.find((entry) => entry.provider === provider);
  const fields =
    providers.find((entry) => entry.provider === provider)?.connection?.routingFields ?? [];
  const compatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  function open() {
    const policy = value.policy?.blockedByPolicy ? null : value.policy;
    const option = options.find((option) => option.id === policy?.provider) ?? options[0];
    setChoice(option ? optionKey(option) : "");
    setProvider(option?.id ?? "");
    setModelId(policy && policy.provider === option?.id ? policy.modelId : "");
    setApiKey("");
    setBaseUrl(option?.baseUrl ?? "");
    setApiProtocol(option?.apiProtocol ?? "chat-completions");
    setRouting({});
    setError(null);
    setEditing(true);
  }
  async function save(clear: boolean) {
    if (busy || !isCurrent()) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(null);
    try {
      if (clear) await client.models.clearWorkspacePolicy(undefined, { signal: controller.signal });
      else
        await client.models.setWorkspacePolicy(
          {
            provider,
            modelId: modelId.trim(),
            apiKey: apiKey.trim(),
            credentialId: null,
            ...(compatible ? { baseUrl: baseUrl.trim(), apiProtocol } : {}),
            ...(fields.length ? { routing } : {}),
          },
          { signal: controller.signal },
        );
      if (!controller.signal.aborted && isCurrent()) {
        setApiKey("");
        setEditing(false);
        setRemoving(false);
        await onChanged();
      }
    } catch {
      if (!controller.signal.aborted && isCurrent()) setError(t`Could not save`);
    } finally {
      if (!controller.signal.aborted && isCurrent()) setBusy(false);
    }
  }
  if (!value.policy && !value.canManage) return null;
  return (
    <section className="mb-6 rounded-xl border border-border p-4" aria-label={t`Workspace model`}>
      <h3 className="text-[15px] font-medium">
        <Trans>Workspace model</Trans>
      </h3>
      {value.policy ? (
        <p className="mt-3 text-sm">
          <strong>{value.policy.provider}</strong> · {value.policy.modelId}
          {value.policy.blockedByPolicy ? (
            <span className="block text-muted-foreground">
              <Trans>Blocked by the server administrator</Trans>
            </span>
          ) : null}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {value.canManage && !editing ? (
        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" onClick={open} disabled={busy}>
            <Trans>Set workspace model</Trans>
          </Button>
          {value.policy ? (
            <Button variant="ghost" size="sm" onClick={() => setRemoving(true)} disabled={busy}>
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      {value.canManage && editing ? (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(false);
          }}
        >
          <fieldset className="grid gap-3" disabled={busy}>
            <Label htmlFor={`${id}-provider`}>
              <Trans>Provider</Trans>
            </Label>
            <NativeSelect
              id={`${id}-provider`}
              value={choice}
              required
              onChange={(event) => {
                const option = options.find((option) => optionKey(option) === event.target.value);
                if (!option) return;
                setChoice(event.target.value);
                setProvider(option.id);
                setBaseUrl(option.baseUrl ?? "");
                setApiProtocol(option.apiProtocol ?? "chat-completions");
                setModelId("");
                setApiKey("");
                setRouting({});
              }}
            >
              <NativeSelectOption value="" disabled>{t`Choose a provider`}</NativeSelectOption>
              {options.map((option) => (
                <NativeSelectOption key={optionKey(option)} value={optionKey(option)}>
                  {option.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Label htmlFor={`${id}-model`}>
              <Trans>Model</Trans>
            </Label>
            <Input
              id={`${id}-model`}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              required
              autoComplete="off"
              list={`${id}-models`}
            />
            <datalist id={`${id}-models`}>
              {catalog
                .filter((entry) => entry.provider === provider && !entry.placeholder)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </datalist>
            {compatible ? (
              <>
                <Label htmlFor={`${id}-url`}>
                  <Trans>API URL</Trans>
                </Label>
                <Input
                  id={`${id}-url`}
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  readOnly={selected?.connection?.customEndpointAllowed === false}
                  required
                />
              </>
            ) : null}
            {fields.map((field) => (
              <div key={field.key} className="grid gap-2">
                <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
                <Input
                  id={`${id}-${field.key}`}
                  value={routing[field.key] ?? ""}
                  required={field.required}
                  onChange={(event) => setRouting({ ...routing, [field.key]: event.target.value })}
                />
              </div>
            ))}
            <Label htmlFor={`${id}-key`}>
              <Trans>API key</Trans>
            </Label>
            <Input
              id={`${id}-key`}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              required
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!provider || !modelId.trim() || !apiKey.trim()}
              >
                <Trans>Save</Trans>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setApiKey("");
                  setEditing(false);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </fieldset>
        </form>
      ) : null}
      <AlertDialog
        open={removing}
        onOpenChange={(open) => {
          if (!busy) setRemoving(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Remove the workspace model?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Members will need their own model connection again.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void save(true);
              }}
            >
              <Trans>Remove</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
