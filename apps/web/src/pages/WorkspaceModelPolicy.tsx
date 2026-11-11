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
  value: { canManage: boolean; policy: { provider: string; modelId: string } | null };
  catalog: ModelCatalogEntry[];
  onChanged: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
      await rpc.models.setWorkspacePolicy({
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
    setError(null);
    setPending(true);
    try {
      await rpc.models.clearWorkspacePolicy();
      await onChanged();
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  return (
    <section className="mb-6 rounded-xl border border-border p-4" aria-label={t`Workspace model`}>
      <h3 className="text-[15px] font-medium">
        <Trans>Workspace model</Trans>
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {value.policy ? (
          <Trans>Everyone in this workspace uses the model selected by the owner.</Trans>
        ) : (
          <Trans>
            Choose one model and API key for everyone in this workspace. Members use their own
            connections until you set one.
          </Trans>
        )}
      </p>
      {value.policy ? (
        <p className="mt-3 text-sm">
          <strong>{value.policy.provider}</strong> · {value.policy.modelId}{" "}
          <span className="text-muted-foreground">
            · <Trans>API key saved securely</Trans>
          </span>
        </p>
      ) : null}
      {value.canManage && !editing ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setEditing(true)}>
            {value.policy ? <Trans>Change model</Trans> : <Trans>Set workspace model</Trans>}
          </Button>
          {value.policy ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              <Trans>Remove</Trans>
            </Button>
          ) : null}
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
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Remove the workspace model?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Members will need their own model connection again. Existing runs may need to be
                restarted.
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
