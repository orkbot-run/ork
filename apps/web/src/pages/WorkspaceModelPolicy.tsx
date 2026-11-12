// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelCatalogEntry } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { workspaceApiModels, workspaceApiProviders } from "@orkbot/core";
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
} from "@orkbot/ui-web";
import { useId, useRef, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

export function WorkspaceModelPolicy({
  value,
  catalog,
  onChanged,
}: {
  value: {
    canManage: boolean;
    policy: { provider: string; modelId: string } | null;
    models?: Array<{ provider: string; modelId: string }>;
  };
  catalog: ModelCatalogEntry[];
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState<{ provider: string; modelId: string } | null>(null);
  const [provider, setProvider] = useState(value.policy?.provider ?? "");
  const [modelId, setModelId] = useState(value.policy?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [supportsImages, setSupportsImages] = useState(false);
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [foundModels, setFoundModels] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  const probeVersion = useRef(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = workspaceApiProviders(catalog);
  const candidates = workspaceApiModels(catalog, provider);
  const routingFields =
    catalog.find((entry) => entry.provider === provider)?.connection?.routingFields ?? [];

  function invalidateProbe() {
    probeVersion.current += 1;
    setFoundModels([]);
    setFinding(false);
  }
  async function findModels() {
    if (!baseUrl.trim() || !apiKey.trim() || finding) return;
    const version = ++probeVersion.current;
    setFinding(true);
    setError(null);
    try {
      const result = await rpc.models.probeOpenAiCompatible({
        baseUrl: baseUrl.trim(),
        apiKey,
        apiProtocol,
        headers: {},
      });
      if (version === probeVersion.current) setFoundModels(result.models);
    } catch {
      if (version === probeVersion.current) setError(t`Could not load workspace model settings.`);
    } finally {
      if (version === probeVersion.current) setFinding(false);
    }
  }

  async function save() {
    if (pending || !provider || !modelId.trim() || !apiKey.trim()) return;
    const key = apiKey;
    setApiKey("");
    setError(null);
    setPending(true);
    try {
      await rpc.models.addWorkspaceModel({
        provider,
        modelId: modelId.trim(),
        apiKey: key,
        credentialId: null,
        ...(routingFields.length
          ? {
              routing: Object.fromEntries(
                Object.entries(routing).filter(([, value]) => value.trim()),
              ),
            }
          : {}),
        ...(provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { baseUrl: baseUrl.trim(), apiProtocol, supportsImages }
          : {}),
      });
      setEditing(false);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  async function remove() {
    if (!removing) return;
    setError(null);
    setPending(true);
    try {
      await rpc.models.removeWorkspaceModel(removing);
      await onChanged();
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
      setRemoving(null);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-border p-4" aria-label={t`Workspace model`}>
      <h3 className="text-[15px] font-medium">
        <Trans>Workspace model</Trans>
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        <Trans>
          Members can use the models shared by the workspace owner. When none are shared, members
          use their own connections.
        </Trans>
      </p>
      {(value.models?.length ? value.models : value.policy ? [value.policy] : []).map((model) => (
        <div
          key={`${model.provider}:${model.modelId}`}
          className="mt-3 flex items-center justify-between gap-2 text-sm"
        >
          <span>
            <strong>{model.provider}</strong> · {model.modelId}
          </span>
          {value.canManage ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(model)}>
              <Trans>Remove</Trans>
            </Button>
          ) : null}
        </div>
      ))}
      {value.canManage && !editing ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setProvider("");
              setModelId("");
              setEditing(true);
            }}
          >
            <Trans>Add workspace model</Trans>
          </Button>
        </div>
      ) : null}
      {editing && value.canManage ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label className="block text-sm">
            <span>
              <Trans>Provider</Trans>
            </span>
            <select
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value);
                setModelId("");
                setRouting({});
                invalidateProbe();
              }}
              required
            >
              <option value="">{t`Choose a provider`}</option>
              {options.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {routingFields.map((field) => (
            <label key={field.key} className="block text-sm" htmlFor={`${ids}-${field.key}`}>
              {field.label}
              <Input
                id={`${ids}-${field.key}`}
                className="mt-1"
                value={routing[field.key] ?? ""}
                required={field.required}
                pattern="[A-Za-z0-9_-]{1,64}"
                onChange={(event) =>
                  setRouting((old) => ({ ...old, [field.key]: event.target.value }))
                }
              />
            </label>
          ))}
          {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={supportsImages}
                onChange={(event) => setSupportsImages(event.target.checked)}
              />
              <Trans>Model supports images</Trans>
            </label>
          ) : null}
          {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <label className="block text-sm" htmlFor={`${ids}-url`}>
              <span>
                <Trans>API URL</Trans>
              </span>
              <Input
                id={`${ids}-url`}
                className="mt-1"
                type="url"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  invalidateProbe();
                }}
                required
              />
            </label>
          ) : null}
          {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <label className="block text-sm" htmlFor={`${ids}-protocol`}>
              <Trans>Protocol</Trans>
              <select
                id={`${ids}-protocol`}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={apiProtocol}
                onChange={(event) => {
                  setApiProtocol(event.target.value as ModelApiProtocol);
                  invalidateProbe();
                }}
              >
                <option value="chat-completions">Chat Completions</option>
                <option value="responses">Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>
          ) : null}
          {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!baseUrl.trim() || !apiKey.trim() || finding}
              onClick={() => void findModels()}
            >
              {finding ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
            </Button>
          ) : null}
          <label className="block text-sm" htmlFor={`${ids}-model`}>
            <span>
              <Trans>Model ID</Trans>
            </span>
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <Input
                id={`${ids}-model`}
                className="mt-1"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                list={`${ids}-models`}
                required
              />
            ) : (
              <select
                id={`${ids}-model`}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                required
              >
                <option value="">{t`Choose a model`}</option>
                {candidates.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            )}
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <datalist id={`${ids}-models`}>
                {[...new Set([...candidates.map((entry) => entry.id), ...foundModels])].map(
                  (id) => (
                    <option key={id} value={id} />
                  ),
                )}
              </datalist>
            ) : null}
          </label>
          <label className="block text-sm" htmlFor={`${ids}-key`}>
            <span>
              <Trans>API key</Trans>
            </span>
            <Input
              id={`${ids}-key`}
              className="mt-1"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                invalidateProbe();
              }}
              required
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              <Trans>
                The key cannot be displayed after saving. Enter a new key to replace it.
              </Trans>
            </span>
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Trans>Saving…</Trans> : <Trans>Save model</Trans>}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setApiKey("");
                setEditing(false);
                setError(null);
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Remove the workspace model?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                If no shared models remain, members will need their own connection. Existing runs
                may need to be restarted.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              <Trans>Remove model</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
