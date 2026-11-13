// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelCatalogEntry, RpcOutput } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import { formatAIBudget, parseAIBudget, ServerAIOAuthAttempt } from "@orkbot/core";
import { Button, Input, Label, NativeSelect, NativeSelectOption, Textarea } from "@orkbot/ui-web";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

export function ServerAIAccountForm({
  account,
  catalog,
  client,
  isCurrent,
  onSaved,
  onCancel,
}: {
  account?: RpcOutput<"serverAI/status">["accounts"][number];
  catalog: ModelCatalogEntry[];
  client: RpcClient;
  isCurrent(): boolean;
  onSaved(): Promise<unknown>;
  onCancel(): void;
}) {
  const { t } = useLingui();
  const id = useId();
  const providers = [
    ...new Map(
      catalog.filter((row) => row.protocol !== "decisions").map((row) => [row.provider, row]),
    ).values(),
  ];
  const [provider, setProvider] = useState(account?.provider ?? providers[0]?.provider ?? "");
  const [label, setLabel] = useState(account?.label ?? "");
  const [models, setModels] = useState(account?.models.join("\n") ?? "");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [budget, setBudget] = useState(formatAIBudget(account?.monthlyBudgetMicros ?? null));
  const [concurrency, setConcurrency] = useState(String(account?.concurrencyLimit ?? 8));
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [oauthLogin, setOAuthLogin] = useState<RpcOutput<"serverAI/beginOAuth"> | null>(null);
  const [oauthPending, setOAuthPending] = useState(false);
  const [code, setCode] = useState("");
  const callbacks = useRef({ onSaved, isCurrent });
  callbacks.current = { onSaved, isCurrent };
  const oauth = useMemo(
    () =>
      new ServerAIOAuthAttempt({
        api: client.serverAI,
        isCurrent: () => callbacks.current.isCurrent(),
        open: async (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        },
        onState: (login, pending) => {
          setOAuthLogin(login);
          setOAuthPending(pending);
          setCode("");
        },
        onError: (message) =>
          setError(
            message === "Connected, but could not refresh."
              ? t`Connected, but could not refresh.`
              : t`Could not complete AI account sign-in.`,
          ),
        onSaved: async () => {
          setKey("");
          await callbacks.current.onSaved();
        },
      }),
    [client, isCurrent],
  );
  useEffect(() => () => oauth.cancel(false), [oauth]);
  const locked = busy || oauthPending;
  const selected = providers.find((row) => row.provider === provider);
  const supportsOAuth = selected?.auth === "oauth" || selected?.auth === "both";
  async function signIn() {
    if (pending.current || oauth.active || !isCurrent()) return;
    setError(null);
    try {
      const limit = Number(concurrency);
      if (!/^\d+$/.test(concurrency) || !Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new Error("Invalid concurrency limit");
      await oauth.start({
        provider,
        connectionId: account?.id ?? null,
        label: label.trim(),
        models: [
          ...new Set(
            models
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ],
        concurrencyLimit: limit,
        monthlyBudgetMicros: parseAIBudget(budget),
      });
    } catch {
      setError(t`Could not save`);
    }
  }
  const fields =
    providers.find((row) => row.provider === provider)?.connection?.routingFields ?? [];
  async function save() {
    if (pending.current || oauth.active || !isCurrent() || (!account && selected?.auth === "oauth"))
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    try {
      const allowed = [
        ...new Set(
          models
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      const limit = Number(concurrency);
      if (!/^\d+$/.test(concurrency) || !Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new Error("Invalid concurrency limit");
      const settings = {
        label: label.trim(),
        models: allowed,
        concurrencyLimit: limit,
        monthlyBudgetMicros: parseAIBudget(budget),
      };
      const connection = {
        provider,
        modelId: allowed[0],
        apiKey: key.trim(),
        credentialId: null,
        ...(provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { baseUrl: url.trim(), enabledModelIds: allowed }
          : {}),
        ...(fields.length ? { routing } : {}),
      };
      if (account) {
        if (key.trim() || (provider === OPENAI_COMPATIBLE_PROVIDER_ID && url.trim()))
          await client.serverAI.reconnect(
            { connectionId: account.id, connection },
            { signal: controller.signal },
          );
        if (!isCurrent() || controller.signal.aborted) return;
        await client.serverAI.update(
          { connectionId: account.id, ...settings },
          { signal: controller.signal },
        );
      } else
        await client.serverAI.create({ ...settings, connection }, { signal: controller.signal });
      if (!isCurrent() || controller.signal.aborted) return;
      setKey("");
      await onSaved();
    } catch {
      if (isCurrent() && !controller.signal.aborted) setError(t`Could not save`);
    } finally {
      pending.current = null;
      if (isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>
          <Trans>Name</Trans>
        </Label>
        <Input
          id={`${id}-name`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={locked}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-provider`}>
          <Trans>Provider</Trans>
        </Label>
        <NativeSelect
          id={`${id}-provider`}
          value={provider}
          disabled={locked || !!account}
          onChange={(event) => {
            setProvider(event.target.value);
            setModels("");
            setKey("");
            setRouting({});
          }}
        >
          {providers.map((row) => (
            <NativeSelectOption key={row.provider} value={row.provider}>
              {row.providerName ?? row.provider}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-models`}>
          <Trans>Models (one per line)</Trans>
        </Label>
        <Textarea
          id={`${id}-models`}
          value={models}
          onChange={(event) => setModels(event.target.value)}
          disabled={locked}
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-url`}>
            <Trans>API URL</Trans>
          </Label>
          <Input
            id={`${id}-url`}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={locked}
          />
        </div>
      ) : null}
      {fields.map((field) => (
        <div className="grid gap-2" key={field.key}>
          <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
          <Input
            id={`${id}-${field.key}`}
            value={routing[field.key] ?? ""}
            onChange={(event) =>
              setRouting((previous) => ({ ...previous, [field.key]: event.target.value }))
            }
            disabled={locked}
          />
        </div>
      ))}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-key`}>
          <Trans>API key</Trans>
        </Label>
        <Input
          id={`${id}-key`}
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={locked}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-concurrency`}>
          <Trans>Concurrent requests</Trans>
        </Label>
        <Input
          id={`${id}-concurrency`}
          type="number"
          min={1}
          max={128}
          value={concurrency}
          onChange={(event) => setConcurrency(event.target.value)}
          disabled={locked}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-budget`}>
          <Trans>Monthly budget (USD)</Trans>
        </Label>
        <Input
          id={`${id}-budget`}
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          disabled={locked}
          inputMode="decimal"
          placeholder={t`Unlimited`}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {oauthLogin ? (
        <div className="grid gap-2">
          <a
            href={oauthLogin.verificationUri}
            target="_blank"
            rel="noreferrer noopener"
            className="text-sm underline"
          >
            <Trans>Open sign-in page</Trans>
          </a>
          {oauthLogin.mode !== "auth-url" ? (
            <p className="select-all font-mono">{oauthLogin.userCode}</p>
          ) : null}
          {oauthLogin.mode === "auth-url" ? (
            <>
              <Label htmlFor={`${id}-code`}>
                <Trans>Verification code</Trans>
              </Label>
              <Input
                id={`${id}-code`}
                type="password"
                autoComplete="off"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="button" disabled={!code.trim()} onClick={() => void oauth.submit(code)}>
                <Trans>Complete sign-in</Trans>
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {supportsOAuth && !oauthPending ? (
          <Button
            type="button"
            disabled={busy || !label.trim() || !models.trim()}
            onClick={() => void signIn()}
          >
            <Trans>Sign in</Trans>
          </Button>
        ) : null}
        {account || selected?.auth !== "oauth" ? (
          <Button type="submit" disabled={locked || !label.trim() || !models.trim() || !provider}>
            <Trans>Save</Trans>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            oauth.cancel();
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}
