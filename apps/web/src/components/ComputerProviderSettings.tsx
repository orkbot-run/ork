// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Capability changes follow LICENSE.md.

import { Trans, useLingui } from "@lingui/react/macro";
import type { Me, ComputerProviderSettings as Settings } from "@orkbot/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@orkbot/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@orkbot/ui-web/components/ui/collapsible";
import { useEffect, useId, useRef, useState } from "react";
import { captureRpcContext } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SuccessPop } from "./ai/primitives";

type Draft = { provider: string; values: Record<string, string> };

// The RPC client hands out a new object on every property read, so pick by scope, never hold it.
function settingsApi(
  scope: "deployment" | "account",
  origin: ReturnType<typeof captureRpcContext>,
) {
  return scope === "account"
    ? origin.client.computerProvider.account
    : origin.client.computerProvider;
}

// Field labels come from the server in English; translate the ones the registry uses.
function useFieldLabel() {
  const { t } = useLingui();
  const labels: Record<string, string> = {
    accessKeyId: t`Access key ID`,
    accessKeySecret: t`Access key secret`,
    apiKey: t`API key`,
    apiToken: t`API token`,
    apiUrl: t`API URL`,
    baseUrl: t`API URL`,
    desktopId: t`Desktop ID`,
    endUserId: t`End user ID`,
    environmentId: t`Environment ID`,
    mcpToken: t`Gateway token`,
    mcpUrl: t`Gateway URL`,
    org: t`Organization`,
    region: t`Region`,
    regionId: t`Region`,
    rootfs: t`Root filesystem`,
    shape: t`Shape`,
    target: t`Target`,
    template: t`Template`,
  };
  return (field: { key: string; label: string }) => labels[field.key] ?? field.label;
}

function draftFrom(settings: Settings): Draft {
  return { provider: settings.provider, values: settings.values };
}

export function ComputerProviderSettings({
  scope,
  onConfigurationChange,
}: {
  scope: "deployment" | "account";
  onConfigurationChange?: (me: Me) => void;
}) {
  const { t } = useLingui();
  const fieldLabel = useFieldLabel();
  const selectId = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef<ReturnType<typeof captureRpcContext> | null>(null);

  useEffect(() => {
    let alive = true;
    const origin = captureRpcContext();
    owner.current = origin;
    settingsApi(scope, origin)
      .get()
      .then((next) => {
        if (!alive || !origin.isCurrent()) return;
        setSettings(next);
        setDraft(draftFrom(next));
      })
      .catch((caught: unknown) => {
        if (alive && origin.isCurrent())
          setError(errorText(caught, t`Could not load computer settings`));
      });
    return () => {
      alive = false;
      if (owner.current === origin) owner.current = null;
    };
  }, [scope, t]);

  if (!draft || !settings) {
    return error ? (
      <p role="alert" className="mt-3 text-[13px] text-destructive">
        {error}
      </p>
    ) : null;
  }

  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...patch });
  };
  async function save() {
    const origin = owner.current;
    if (!draft || pending || !origin?.isCurrent()) return;
    const isCurrent = () => owner.current === origin && origin.isCurrent();
    setPending(true);
    setError(null);
    try {
      const next = await settingsApi(scope, origin).update(draft);
      if (!isCurrent()) return;
      setSettings(next);
      setDraft(draftFrom(next));
      setSaved(true);
      if (onConfigurationChange) {
        const me = await origin.client.me();
        if (isCurrent()) onConfigurationChange(me);
      }
    } catch (caught) {
      if (isCurrent()) setError(errorText(caught, t`Could not save computer settings`));
    } finally {
      if (isCurrent()) setPending(false);
    }
  }

  const descriptor = settings.providers.find((provider) => provider.id === draft.provider);
  if (settings.providers.length === 0) return null;
  return (
    <>
      <form
        className="mt-4 grid gap-3"
        data-testid="computer-provider-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {/* Edits made while a save is in flight would be replaced by what it saved. */}
        <fieldset className="contents" disabled={pending}>
          <Field>
            <FieldLabel htmlFor={selectId}>
              <Trans>New computers run on</Trans>
            </FieldLabel>
            <NativeSelect
              id={selectId}
              value={draft.provider}
              onChange={(event) =>
                set({
                  provider: event.target.value,
                  values: event.target.value === settings.provider ? settings.values : {},
                })
              }
              className="w-full"
            >
              <NativeSelectOption value="default">
                <Trans>Default</Trans>
              </NativeSelectOption>
              {settings.providers.map((provider) => (
                <NativeSelectOption key={provider.id} value={provider.id}>
                  {provider.displayName}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {descriptor?.fields.map((field) => {
            const saved =
              draft.provider === settings.provider &&
              settings.savedSecrets[field.key] &&
              !descriptor.fields.some(
                (candidate) =>
                  candidate.kind === "url" &&
                  draft.values[candidate.key] !== settings.values[candidate.key],
              );
            const change = (value: string) =>
              set({ values: { ...draft.values, [field.key]: value } });
            return field.kind === "select" ? (
              <Field key={field.key}>
                <FieldLabel htmlFor={`${selectId}-${field.key}`}>{fieldLabel(field)}</FieldLabel>
                <NativeSelect
                  id={`${selectId}-${field.key}`}
                  value={draft.values[field.key] ?? ""}
                  onChange={(event) => change(event.target.value)}
                  required={field.required}
                >
                  <NativeSelectOption value="" />
                  {field.options?.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : (
              <TextField
                key={field.key}
                label={fieldLabel(field)}
                value={draft.values[field.key] ?? ""}
                onChange={change}
                required={field.required && !saved}
                secret={field.kind === "secret"}
                type={field.kind === "url" ? "url" : "text"}
                placeholder={saved ? t`Saved` : undefined}
              />
            );
          })}
        </fieldset>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            <Trans>Save</Trans>
          </Button>
          {saved ? <SuccessPop label={t`Saved`} /> : null}
        </div>
      </form>
      {scope === "deployment" &&
      settings.providers.some((provider) => provider.capabilities.perAccount) ? (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="text-[13px] text-muted-foreground">
            <Trans>My computers</Trans>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ComputerProviderSettings scope="account" />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  required,
  secret,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  type?: "text" | "url";
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={secret ? "password" : type}
        autoComplete={secret ? "off" : undefined}
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
