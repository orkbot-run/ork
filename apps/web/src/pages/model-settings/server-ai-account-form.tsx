// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelCatalogEntry, RpcOutput } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import {
  formatAIBudget,
  modelConnectionOptions,
  parseAIBudget,
  ServerAIOAuthAttempt,
} from "@orkbot/core";
import {
  Button,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Switch,
  Textarea,
} from "@orkbot/ui-web";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FoundModelPicker } from "../../components/FoundModelPicker";
import { useCopyText } from "../../lib/copy-text";
import { desktopBridge } from "../../lib/desktop";
import type { RpcClient } from "../../lib/rpc";

function defaultModel(catalog: ModelCatalogEntry[], provider: string) {
  const available = catalog.filter(
    (row) => row.provider === provider && row.protocol !== "decisions" && !row.placeholder,
  );
  return (available.find((row) => row.recommended) ?? available[0])?.id ?? "";
}

export function ServerAIAccountForm({
  account,
  hideBudget,
  setup = false,
  catalog,
  client,
  isCurrent,
  onSaved,
  onCancel,
}: {
  account?: RpcOutput<"serverAI/status">["accounts"][number];
  hideBudget?: boolean;
  setup?: boolean;
  catalog: ModelCatalogEntry[];
  client: RpcClient;
  isCurrent(): boolean;
  onSaved(connectionId: string): Promise<unknown>;
  onCancel(): void;
}) {
  const { t } = useLingui();
  const id = useId();
  const providersById = new Map<string, ModelCatalogEntry>();
  for (const row of catalog) {
    if (row.protocol !== "decisions" && !providersById.has(row.provider))
      providersById.set(row.provider, row);
  }
  const providers = [...providersById.values()];
  const connectionOptions = modelConnectionOptions(catalog).filter((option) =>
    providersById.has(option.id),
  );
  const presets = connectionOptions.filter((option) => option.baseUrl);
  const genericProviders = providers.filter((row) =>
    connectionOptions.some((option) => option.id === row.provider && !option.baseUrl),
  );
  const initialOption =
    account || setup
      ? undefined
      : (connectionOptions.find(
          (option) => option.id === providers[0]?.provider && !option.baseUrl,
        ) ??
        connectionOptions.find((option) => option.id === providers[0]?.provider) ??
        connectionOptions[0]);
  const [setupChoice, setSetupChoice] = useState(
    initialOption?.baseUrl
      ? JSON.stringify([initialOption.id, initialOption.baseUrl])
      : (initialOption?.id ?? ""),
  );
  const initialProvider = account?.provider ?? initialOption?.id ?? "";
  const [provider, setProvider] = useState(initialProvider);
  const [label, setLabel] = useState(account?.label ?? initialOption?.name ?? initialProvider);
  const [models, setModels] = useState(
    () => account?.models.join("\n") ?? defaultModel(catalog, initialProvider),
  );
  const [authentication, setAuthentication] = useState<"sign-in" | "key">(() => {
    const auth = providers.find((row) => row.provider === initialProvider)?.auth;
    return auth === "oauth" || auth === "both" ? "sign-in" : "key";
  });
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(initialOption?.baseUrl ?? "");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>(
    initialOption?.apiProtocol ?? "chat-completions",
  );
  const [budget, setBudget] = useState(formatAIBudget(account?.monthlyBudgetMicros ?? null));
  const [concurrency, setConcurrency] = useState(String(account?.concurrencyLimit ?? 8));
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [zeroDataRetention, setZeroDataRetention] = useState(account?.zeroDataRetention ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [oauthLogin, setOAuthLogin] = useState<RpcOutput<"serverAI/beginOAuth"> | null>(null);
  const [oauthPending, setOAuthPending] = useState(false);
  const [code, setCode] = useState("");
  const [codeCopied, copyCode, copyFailed] = useCopyText();
  const callbacks = useRef({ onSaved, isCurrent });
  callbacks.current = { onSaved, isCurrent };
  const oauth = useMemo(
    () =>
      new ServerAIOAuthAttempt({
        api: client.serverAI,
        isCurrent: () => callbacks.current.isCurrent(),
        open: async (url) => {
          try {
            const browser = desktopBridge()?.oauth;
            if (browser?.open) await browser.open(url);
            else window.open(url, "_blank", "noopener,noreferrer");
          } catch {
            // Keep polling this attempt. The on-screen link can still open the same request.
          }
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
              : t`Could not complete provider sign-in.`,
          ),
        onSaved: async (connectionId) => {
          setKey("");
          await callbacks.current.onSaved(connectionId);
        },
      }),
    [client, isCurrent],
  );
  useEffect(() => () => oauth.cancel(false), [oauth]);
  const locked = busy || oauthPending;
  const availableModels = useMemo(
    () => [
      ...new Set(
        catalog
          .filter(
            (row) =>
              row.provider === provider &&
              row.protocol !== "decisions" &&
              !row.placeholder &&
              row.id,
          )
          .map((row) => row.id),
      ),
    ],
    [catalog, provider],
  );
  const selected = providers.find((row) => row.provider === provider);
  const supportsOAuth = selected?.auth === "oauth" || selected?.auth === "both";
  const subscriptionSignIn = supportsOAuth && authentication === "sign-in";
  const acceptsKey = !!selected && selected.auth !== "oauth" && authentication === "key";
  async function signIn(choice?: { provider: string; label: string; models: string[] }) {
    if (pending.current || oauth.active || (!choice && !subscriptionSignIn) || !isCurrent()) return;
    setError(null);
    try {
      const limit = Number(concurrency);
      if (!/^\d+$/.test(concurrency) || !Number.isInteger(limit) || limit < 1 || limit > 128)
        throw new Error("Invalid concurrency limit");
      await oauth.start({
        provider: choice?.provider ?? provider,
        connectionId: account?.id ?? null,
        label: choice?.label ?? label.trim(),
        models: choice?.models ?? [
          ...new Set(
            models
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ],
        concurrencyLimit: limit,
        monthlyBudgetMicros: hideBudget
          ? (account?.monthlyBudgetMicros ?? null)
          : parseAIBudget(budget),
      });
    } catch {
      setError(t`Could not save`);
    }
  }
  const fields =
    providers.find((row) => row.provider === provider)?.connection?.routingFields ?? [];
  async function save() {
    if (pending.current || oauth.active || !isCurrent() || (!account && !acceptsKey)) return;
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
        ...(selected?.connection?.supportsZeroDataRetention &&
        account &&
        zeroDataRetention !== (account.zeroDataRetention ?? false)
          ? { zeroDataRetention }
          : {}),
        models: allowed,
        concurrencyLimit: limit,
        monthlyBudgetMicros: hideBudget
          ? (account?.monthlyBudgetMicros ?? null)
          : parseAIBudget(budget),
      };
      const connection = {
        provider,
        modelId: allowed[0],
        apiKey: key.trim(),
        credentialId: null,
        ...(provider === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { baseUrl: url.trim(), enabledModelIds: allowed, apiProtocol }
          : {}),
        ...(fields.length ? { routing } : {}),
        ...(selected?.connection?.supportsZeroDataRetention ? { zeroDataRetention } : {}),
      };
      let connectionId: string;
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
        connectionId = account.id;
      } else {
        const saved = await client.serverAI.create(
          { ...settings, connection },
          { signal: controller.signal },
        );
        connectionId = saved.id;
      }
      if (!isCurrent() || controller.signal.aborted) return;
      setKey("");
      await onSaved(connectionId);
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
      {setup ? null : (
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
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-provider`}>
          <Trans>Provider</Trans>
        </Label>
        <NativeSelect
          id={`${id}-provider`}
          value={account ? provider : setupChoice}
          disabled={locked || !!account}
          onChange={(event) => {
            const preset = presets.find(
              (option) => JSON.stringify([option.id, option.baseUrl]) === event.target.value,
            );
            const [nextProvider, nextAuth] = preset
              ? [preset.id, "key"]
              : setup
                ? event.target.value.split(":")
                : [event.target.value];
            setSetupChoice(event.target.value);
            setUrl(preset?.baseUrl ?? "");
            setApiProtocol(preset?.apiProtocol ?? "chat-completions");
            const next = providers.find((row) => row.provider === nextProvider);
            const auth =
              nextAuth === "key"
                ? "key"
                : next?.auth === "oauth" || next?.auth === "both"
                  ? "sign-in"
                  : "key";
            const model = defaultModel(catalog, nextProvider!);
            setProvider(nextProvider!);
            setModels(model);
            setAuthentication(auth);
            if (
              !label.trim() ||
              label === (selected?.providerName ?? provider) ||
              label ===
                connectionOptions.find(
                  (option) =>
                    (option.baseUrl ? JSON.stringify([option.id, option.baseUrl]) : option.id) ===
                    setupChoice,
                )?.name
            )
              setLabel(preset?.name ?? next?.providerName ?? event.target.value);
            setKey("");
            setRouting({});
            setZeroDataRetention(false);
            if (setup && next) {
              setLabel(preset?.name ?? next.providerName ?? next.provider);
              if (auth === "sign-in")
                void signIn({
                  provider: next.provider,
                  label: next.providerName ?? next.provider,
                  models: [model],
                });
            }
          }}
        >
          {setup ? <NativeSelectOption value="">{t`Choose a provider`}</NativeSelectOption> : null}
          {setup
            ? genericProviders.flatMap((row) => [
                ...(row.auth === "oauth" || row.auth === "both"
                  ? [
                      <NativeSelectOption
                        key={`${row.provider}:sign-in`}
                        value={`${row.provider}:sign-in`}
                      >
                        {row.oauthLabel ?? row.providerName ?? row.provider}
                      </NativeSelectOption>,
                    ]
                  : []),
                ...(row.auth !== "oauth"
                  ? [
                      <NativeSelectOption key={`${row.provider}:key`} value={`${row.provider}:key`}>
                        {row.providerName ?? row.provider}
                        {row.auth === "both" ? ` · ${t`API key`}` : ""}
                      </NativeSelectOption>,
                    ]
                  : []),
              ])
            : genericProviders.map((row) => (
                <NativeSelectOption key={row.provider} value={row.provider}>
                  {row.providerName ?? row.provider}
                </NativeSelectOption>
              ))}
          {presets.map((option) => (
            <NativeSelectOption
              key={JSON.stringify([option.id, option.baseUrl])}
              value={JSON.stringify([option.id, option.baseUrl])}
            >
              {option.name}
            </NativeSelectOption>
          ))}
          {account && !genericProviders.some((row) => row.provider === provider) ? (
            <NativeSelectOption value={provider}>
              {selected?.providerName ?? provider}
            </NativeSelectOption>
          ) : null}
        </NativeSelect>
        {!setup && selected?.authHint ? (
          <p className="text-sm text-muted-foreground">{selected.authHint}</p>
        ) : null}
      </div>
      {!setup && selected?.auth === "both" ? (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-authentication`}>
            <Trans>Authentication</Trans>
          </Label>
          <NativeSelect
            id={`${id}-authentication`}
            value={authentication}
            disabled={locked}
            onChange={(event) => {
              setAuthentication(event.target.value === "sign-in" ? "sign-in" : "key");
              setKey("");
            }}
          >
            <NativeSelectOption value="sign-in">
              {selected.oauthLabel ?? t`Sign in`}
            </NativeSelectOption>
            <NativeSelectOption value="key">
              <Trans>API key</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </div>
      ) : null}
      {acceptsKey ? (
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
      ) : null}
      <details open={!setup || undefined} hidden={setup && !provider}>
        {setup ? <summary className="cursor-pointer text-sm">{t`Advanced`}</summary> : null}
        <div className="grid gap-4">
          {" "}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-models`}>
              <Trans>Models (one per line)</Trans>
            </Label>
            {availableModels.length > 0 && !locked ? (
              <FoundModelPicker
                models={availableModels}
                value={t`Browse models`}
                otherValue="__custom_model__"
                onChange={(model) => {
                  if (model === "__custom_model__") {
                    document.getElementById(`${id}-models`)?.focus();
                    return;
                  }
                  setModels((current) => {
                    const entries = current
                      .split(/\r?\n/)
                      .map((entry) => entry.trim())
                      .filter(Boolean);
                    return entries.includes(model) ? current : [...entries, model].join("\n");
                  });
                }}
              />
            ) : null}
            <Textarea
              id={`${id}-models`}
              value={models}
              onChange={(event) => setModels(event.target.value)}
              disabled={locked}
              autoCapitalize="none"
              autoCorrect="off"
            />
          </div>
          {acceptsKey && provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-url`}>
                <Trans>API URL</Trans>
              </Label>
              <Input
                id={`${id}-url`}
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                readOnly={!account && selected?.connection?.customEndpointAllowed === false}
                disabled={locked}
              />
            </div>
          ) : null}
          {selected?.connection?.supportsZeroDataRetention ? (
            <>
              <label
                htmlFor={`${id}-zero-data-retention`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <Trans>Zero data retention</Trans>
                <Switch
                  id={`${id}-zero-data-retention`}
                  aria-label={t`Zero data retention`}
                  aria-describedby={`${id}-zero-data-retention-description`}
                  checked={zeroDataRetention}
                  disabled={locked}
                  onCheckedChange={setZeroDataRetention}
                />
              </label>
              <p
                id={`${id}-zero-data-retention-description`}
                className="text-sm text-muted-foreground"
              >
                <Trans>
                  Route requests only to endpoints marked as eligible for zero data retention.
                </Trans>
              </p>
            </>
          ) : null}
          {(acceptsKey ? fields : []).map((field) => (
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
          {!hideBudget ? (
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
          ) : null}
        </div>
      </details>
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
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>After signing in, enter this code on the provider’s page.</Trans>
              </p>
              <div className="flex flex-wrap items-center gap-3 rounded-md bg-muted p-3">
                <p className="flex-1 select-all font-mono text-lg font-medium">
                  {oauthLogin.userCode}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => copyCode(oauthLogin.userCode)}
                >
                  {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                </Button>
              </div>
              {copyFailed ? (
                <p role="alert" className="text-sm text-destructive">
                  <Trans>Could not copy. Select the code and copy it manually.</Trans>
                </p>
              ) : null}
            </>
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
      {oauthPending && oauthLogin?.mode !== "auth-url" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
          {oauthLogin ? (
            <Trans>Waiting for you to confirm the code.</Trans>
          ) : (
            <Trans>Opening sign-in…</Trans>
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {subscriptionSignIn && !oauthPending ? (
          <Button
            type="button"
            disabled={busy || !label.trim() || !models.trim()}
            onClick={() => void signIn()}
          >
            {selected?.oauthLabel ?? t`Sign in`}
          </Button>
        ) : null}
        {account || (acceptsKey && provider) ? (
          <Button
            type="submit"
            disabled={
              locked || !label.trim() || !models.trim() || !provider || (setup && !key.trim())
            }
          >
            {setup ? <Trans>Connect</Trans> : <Trans>Save</Trans>}
          </Button>
        ) : null}
        {!setup || oauthPending ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              oauth.cancel();
              if (!setup) onCancel();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
