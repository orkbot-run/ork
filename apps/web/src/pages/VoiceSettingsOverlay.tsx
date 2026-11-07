// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Confirmed voice settings changes follow LICENSE.md.

import { Trans, useLingui } from "@lingui/react/macro";
import type {
  SettingsScope,
  VoiceCatalogEntry,
  VoiceCredential,
  VoiceInfo,
  VoiceStatus,
} from "@orkbot/contracts";
import {
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@orkbot/contracts";
import { fetchFresh, writeSaved } from "@orkbot/core/query";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Spinner,
} from "@orkbot/ui-web";
import { useQueryClient } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSpaceQueries } from "../lib/query";
import { captureRpcContext } from "../lib/rpc";
import { useBoundSpaceId } from "../lib/space-rpc";
import { speaker } from "../lib/tts";
import { errorText } from "../lib/user-error";

export function VoiceSettingsOverlay({
  onClose,
  embedded = false,
  onBusyChange,
  scope,
}: {
  onClose: () => void;
  /** Render the content only, inside the shared Settings shell's scroller. */
  embedded?: boolean;
  onBusyChange?: (busy: boolean) => void;
  /**
   * The account's voice, or the bound Space's own when it overrides it. Connections are
   * account-wide, so a Space only picks among them and connects missing ones.
   */
  scope: SettingsScope;
}) {
  const spaceId = useBoundSpaceId();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const scoped = { input: { scope } };
  const origin = useMemo(
    () => ({ ...captureRpcContext(spaceId ?? undefined), queries, scope }),
    [spaceId, queries, scope],
  );
  const rpc = origin.client;
  const live = useRef<typeof origin | null>(origin);
  const previousOrigin = useRef(origin);
  const loadRevision = useRef(0);
  const mutationRevision = useRef(0);
  const fieldRevisions = useRef<Partial<Record<EditableField, number>>>({});
  const apiKeyRevision = useRef(0);
  // A revisit opens with what this scope showed last time and refreshes it in the background.
  const [cached] = useState(() => {
    const catalog = queryClient.getQueryData(queries.voice.catalog.queryKey());
    const credentials = queryClient.getQueryData(queries.voice.credentials.queryKey(scoped));
    const status = queryClient.getQueryData(queries.voice.status.queryKey(scoped));
    if (!catalog || !credentials || !status) return null;
    const provider = selectedProvider(catalog, [status.provider]);
    const credential = credentials.find((entry) => entry.provider === provider);
    const voices = credential
      ? (queryClient.getQueryData(queries.voice.voices.queryKey({ input: { provider, scope } })) ??
        [])
      : [];
    return { catalog, credentials, status, provider, credential, voices };
  });
  const { t } = useLingui();
  const apiKeyId = useId();
  const voiceSelectId = useId();
  const speechModelId = useId();
  const baseUrlId = useId();
  const ttsModelId = useId();
  const sttModelId = useId();
  const providerSelectId = useId();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>(cached?.catalog ?? []);
  const [credentials, setCredentials] = useState<VoiceCredential[]>(cached?.credentials ?? []);
  const [status, setStatus] = useState<VoiceStatus | null>(cached?.status ?? null);
  const [provider, setProvider] = useState(cached?.provider ?? "");
  // The provider being edited, read by loads that finish after the user picked another one.
  const providerRef = useRef(provider);
  // Fields the user changed since the form was last filled; a background refresh keeps them.
  const edited = useRef(new Set<EditableField>());
  // Each list remembers its provider, so one provider's voices never show under another.
  const [voiceList, setVoiceList] = useState<{ provider: string; voices: VoiceInfo[] }>({
    provider: cached?.provider ?? "",
    voices: cached?.voices ?? [],
  });
  const voices = voiceList.provider === provider ? voiceList.voices : NO_VOICES;
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(
    cached?.credential?.voiceId || (cached?.credential ? (cached.voices[0]?.id ?? "") : ""),
  );
  const [speechModel, setSpeechModel] = useState(cached?.credential?.speechModel ?? "");
  const [baseUrl, setBaseUrl] = useState(cached?.credential?.endpoint ?? "");
  const [ttsModel, setTtsModel] = useState(cached?.credential?.ttsModel ?? "");
  const [sttModel, setSttModel] = useState(cached?.credential?.sttModel ?? "");
  const speechModelSave = useRef<string | null>(null);
  const voicesRequest = useRef(0);
  const [loading, setLoading] = useState(!cached);
  const [pending, setPending] = useState<"connect" | "disconnect" | "voice" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const ownerCurrent = () => live.current === origin && origin.isCurrent();
  useLayoutEffect(() => {
    live.current = origin;
    if (previousOrigin.current !== origin) {
      previousOrigin.current = origin;
      speechModelSave.current = null;
      setCatalog([]);
      setCredentials([]);
      setStatus(null);
      setProvider("");
      providerRef.current = "";
      setVoiceList({ provider: "", voices: [] });
      setApiKey("");
      setVoiceId("");
      setSpeechModel("");
      setBaseUrl("");
      setTtsModel("");
      setSttModel("");
      edited.current.clear();
      fieldRevisions.current = {};
      apiKeyRevision.current++;
      setError(null);
      setNotice(null);
      setLoading(true);
      markPending(null);
    }
    return () => {
      if (live.current === origin) live.current = null;
      loadRevision.current++;
      mutationRevision.current++;
      voicesRequest.current++;
    };
  }, [origin]);

  function changed(field: EditableField) {
    edited.current.add(field);
    fieldRevisions.current[field] = (fieldRevisions.current[field] ?? 0) + 1;
  }
  function beginMutation(kind: "connect" | "disconnect" | "voice" | "test") {
    if (!ownerCurrent()) return null;
    const revision = ++mutationRevision.current;
    if (kind !== "test") {
      loadRevision.current++;
      voicesRequest.current++;
    }
    markPending(kind);
    return { current: () => ownerCurrent() && mutationRevision.current === revision };
  }
  function assertCurrent(current: () => boolean) {
    if (!current()) throw new DOMException("Session changed", "AbortError");
  }
  function fillFields(cred: VoiceCredential | undefined, keepForm: boolean) {
    const keep = (field: EditableField) => keepForm && edited.current.has(field);
    if (!keep("voiceId")) setVoiceId(cred?.voiceId ?? "");
    if (!keep("speechModel")) setSpeechModel(cred?.speechModel ?? "");
    if (!keep("baseUrl")) setBaseUrl(cred?.endpoint ?? "");
    if (!keep("ttsModel")) setTtsModel(cred?.ttsModel ?? "");
    if (!keep("sttModel")) setSttModel(cred?.sttModel ?? "");
  }
  async function keepCredentials(
    update: (current: VoiceCredential[]) => VoiceCredential[],
    current: () => boolean,
  ) {
    await writeSaved(queryClient, queries.voice.credentials.queryKey(scoped), (cached) => {
      assertCurrent(current);
      return update(cached ?? []);
    });
  }
  async function keepStatus(saved: VoiceStatus, current: () => boolean) {
    await writeSaved(queryClient, queries.voice.status.queryKey(scoped), () => {
      assertCurrent(current);
      return saved;
    });
  }
  function refreshAfterSave(nextProvider: string | undefined, current: () => boolean) {
    void refresh(nextProvider, { keepForm: true }).catch((err: unknown) => {
      if (current()) setError(errorText(err, t`Could not load voice settings`));
    });
  }

  const canPreview = useSyncExternalStore(
    speaker.subscribeOwnership,
    speaker.canSpeak,
    speaker.canSpeak,
  );
  const busy = pending !== null;

  useEffect(() => {
    return () => onBusyChange?.(false);
  }, [onBusyChange]);

  function markPending(next: "connect" | "disconnect" | "voice" | "test" | null) {
    setPending(next);
    onBusyChange?.(next !== null);
  }

  /**
   * Fill the form from the provider's saved credential; voices load without blocking the form.
   * A background refresh of the provider already on screen keeps only the fields the user has
   * edited; the rest follow the saved settings, which may have changed elsewhere.
   */
  function showProvider(
    nextProvider: string,
    nextCredentials: VoiceCredential[],
    keepForm = false,
  ) {
    const request = ++voicesRequest.current;
    const cred = nextCredentials.find((entry) => entry.provider === nextProvider);
    const activeVoice = cred?.voiceId ?? "";
    const keep = (field: EditableField) => keepForm && edited.current.has(field);
    if (!keepForm) {
      edited.current.clear();
      providerRef.current = nextProvider;
      setProvider(nextProvider);
      setVoiceList({ provider: nextProvider, voices: [] });
    }
    fillFields(cred, keepForm);
    if (!cred) return Promise.resolve();
    return queryClient
      .fetchQuery(
        queries.voice.voices.queryOptions({
          input: { provider: nextProvider, scope },
          staleTime: 0,
          queryFn: ({ signal }) => {
            assertCurrent(origin.isCurrent);
            return rpc.voice.voices({ provider: nextProvider, scope }, { signal });
          },
        }),
      )
      .then(
        (listed) => {
          if (!ownerCurrent() || request !== voicesRequest.current) return;
          setVoiceList({ provider: nextProvider, voices: listed });
          if (!keep("voiceId") && !activeVoice && listed[0]) setVoiceId(listed[0].id);
        },
        (err: unknown) => {
          if (ownerCurrent() && request === voicesRequest.current) throw err;
        },
      );
  }

  /** After a change (every call but the one on open) it never reuses a read sent before it.
   * Cache-owned requests can survive a same-session remount; only UI publication uses its revision.
   */
  async function refresh(nextProvider?: string, { keepForm = false, reuse = false } = {}) {
    const revision = ++loadRevision.current;
    const current = () => ownerCurrent() && revision === loadRevision.current;
    if (!current()) return;
    try {
      const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
        fetchFresh(
          queryClient,
          {
            ...queries.voice.catalog.queryOptions(),
            queryFn: ({ signal }) => {
              assertCurrent(origin.isCurrent);
              return rpc.voice.catalog(undefined, { signal });
            },
          },
          { reuse },
        ),
        fetchFresh(
          queryClient,
          {
            ...queries.voice.credentials.queryOptions(scoped),
            queryFn: ({ signal }) => {
              assertCurrent(origin.isCurrent);
              return rpc.voice.credentials({ scope }, { signal });
            },
          },
          { reuse },
        ),
        fetchFresh(
          queryClient,
          {
            ...queries.voice.status.queryOptions(scoped),
            queryFn: ({ signal }) => {
              assertCurrent(origin.isCurrent);
              return rpc.voice.status({ scope }, { signal });
            },
          },
          { reuse },
        ),
      ]);
      if (!current()) return;
      const selected = selectedProvider(nextCatalog, [
        nextProvider,
        providerRef.current,
        nextStatus.provider,
      ]);
      setCatalog(nextCatalog);
      setCredentials(nextCredentials);
      setStatus(nextStatus);
      await showProvider(selected, nextCredentials, keepForm && selected === providerRef.current);
    } catch (err) {
      if (current()) throw err;
    }
  }

  async function chooseProvider(nextProvider: string) {
    if (pending) return;
    const action = beginMutation("voice");
    if (!action) return;
    setApiKey("");
    apiKeyRevision.current++;
    setError(null);
    setNotice(null);
    const cred = credentials.find((entry) => entry.provider === nextProvider);
    try {
      if (
        catalog.find((entry) => entry.id === nextProvider)?.keyless &&
        cred?.voiceId &&
        status?.provider !== nextProvider
      ) {
        try {
          const saved = await rpc.voice.setVoice({
            scope,
            voiceId: cred.voiceId,
            provider: nextProvider,
          });
          if (!action.current()) return;
          setStatus(saved);
          await keepStatus(saved, action.current);
        } catch (err) {
          if (action.current()) setError(errorText(err, t`Could not save that voice`));
          return;
        }
      }
      if (!action.current()) return;
      await showProvider(nextProvider, credentials);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not load voice settings`));
    } finally {
      if (action.current()) markPending(null);
    }
  }

  useEffect(() => {
    void refresh(undefined, { keepForm: Boolean(cached), reuse: true })
      .catch((err: unknown) => {
        if (ownerCurrent()) setError(errorText(err, t`Could not load voice settings`));
      })
      .finally(() => {
        if (ownerCurrent()) setLoading(false);
      });
  }, [origin]);

  const selected = catalog.find((entry) => entry.id === provider) ?? catalog[0];
  const credential = credentials.find((entry) => entry.provider === provider);
  const hiddenSelfHosted =
    !catalog.some((entry) => entry.id === OPENAI_COMPATIBLE_PROVIDER_ID) &&
    credentials.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID);
  const voiceOptions = useMemo(
    () => (voices.length ? voices : voiceId ? [{ id: voiceId, label: voiceId }] : []),
    [voices, voiceId],
  );

  const selfHosted = selected?.id === OPENAI_COMPATIBLE_PROVIDER_ID;
  // Connections are managed from the account; a Space can still connect one it lacks.
  const managesConnection = scope === "account" || !credential;
  const keyless = Boolean(selected?.keyless);
  const canConnect = keyless || (selfHosted ? Boolean(baseUrl.trim()) : apiKey.trim().length >= 8);

  async function connectKey() {
    if (!selected || !canConnect || pending) return;
    const action = beginMutation("connect");
    if (!action) return;
    setError(null);
    setNotice(null);
    const sentApiKey = apiKey;
    const sentKeyRevision = apiKeyRevision.current;
    const sentFields = { ...fieldRevisions.current };
    try {
      const saved = await rpc.voice.connect({
        scope,
        provider: selected.id,
        apiKey: sentApiKey.trim(),
        voiceId: voiceId || undefined,
        ...(selected.id === "fish-audio" ? { speechModel: speechModel.trim() } : {}),
        ...(selfHosted
          ? {
              baseUrl: baseUrl.trim(),
              ttsModel: ttsModel.trim() || undefined,
              sttModel: sttModel.trim() || undefined,
            }
          : {}),
      });
      if (!action.current()) return;
      const merge = (current: VoiceCredential[]) => [
        ...current
          .filter((entry) => entry.provider !== saved.provider)
          .map((entry) => (saved.isDefault ? { ...entry, isDefault: false } : entry)),
        saved,
      ];
      const confirmed: VoiceStatus = {
        configured: true,
        ready: Boolean(saved.voiceId),
        provider: saved.provider,
        voiceId: saved.voiceId,
        transcribe: saved.transcribe,
      };
      for (const field of ["voiceId", "speechModel", "baseUrl", "ttsModel", "sttModel"] as const)
        if (fieldRevisions.current[field] === sentFields[field]) edited.current.delete(field);
      setApiKey((current) => (apiKeyRevision.current === sentKeyRevision ? "" : current));
      setCredentials(merge);
      setStatus(confirmed);
      fillFields(saved, true);
      await Promise.all([
        keepCredentials(merge, action.current),
        keepStatus(confirmed, action.current),
      ]);
      if (!action.current()) return;
      setNotice(t`Connected ${selected.name}.`);
      refreshAfterSave(selected.id, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not connect this voice provider`));
    } finally {
      if (action.current()) markPending(null);
    }
  }

  async function disconnectProvider(providerId = credential?.provider) {
    if (!providerId || pending) return;
    const action = beginMutation("disconnect");
    if (!action) return;
    const sentKeyRevision = apiKeyRevision.current;
    setError(null);
    setNotice(null);
    try {
      await rpc.voice.disconnect({ provider: providerId });
      if (!action.current()) return;
      const remove = (current: VoiceCredential[]) =>
        current.filter((entry) => entry.provider !== providerId);
      setCredentials(remove);
      setApiKey((current) => (apiKeyRevision.current === sentKeyRevision ? "" : current));
      if (providerRef.current === providerId) {
        fillFields(undefined, true);
        setVoiceList({ provider: providerId, voices: [] });
      }
      await keepCredentials(remove, action.current);
      if (!action.current()) return;
      await queryClient.cancelQueries({
        queryKey: queries.voice.status.queryKey(scoped),
        exact: true,
      });
      if (!action.current()) return;
      if (status?.provider === providerId) {
        setStatus(null);
        queryClient.removeQueries({ queryKey: queries.voice.status.queryKey(scoped), exact: true });
      }
      refreshAfterSave(providerId, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not disconnect this voice provider`));
    } finally {
      if (action.current()) markPending(null);
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    changed("voiceId");
    setVoiceId(nextVoiceId);
    if (!credential || pending) return;
    const action = beginMutation("voice");
    if (!action) return;
    const sentRevision = fieldRevisions.current.voiceId;
    setError(null);
    try {
      const saved = await rpc.voice.setVoice({
        scope,
        voiceId: nextVoiceId,
        provider: selected?.id,
      });
      if (!action.current()) return;
      const merge = (current: VoiceCredential[]) =>
        current.map((entry) =>
          entry.provider === saved.provider
            ? { ...entry, voiceId: saved.voiceId, isDefault: true }
            : { ...entry, isDefault: false },
        );
      setStatus(saved);
      setCredentials(merge);
      if (fieldRevisions.current.voiceId === sentRevision) {
        edited.current.delete("voiceId");
        setVoiceId(saved.voiceId);
      }
      await Promise.all([
        keepStatus(saved, action.current),
        keepCredentials(merge, action.current),
      ]);
      if (action.current()) refreshAfterSave(selected?.id, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not save that voice`));
    } finally {
      if (action.current()) markPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!credential || selected?.id !== "fish-audio" || pending) return;
    const next = speechModel.trim();
    if (next === credential.speechModel || speechModelSave.current === next) return;
    const action = beginMutation("voice");
    if (!action) return;
    const sentRevision = fieldRevisions.current.speechModel;
    speechModelSave.current = next;
    setError(null);
    try {
      const saved = await rpc.voice.setSpeechModel({
        scope,
        provider: selected.id,
        speechModel: next,
      });
      if (!action.current()) return;
      const update = (current: VoiceCredential[]) =>
        current.map((entry) => (entry.id === saved.id ? saved : entry));
      if (fieldRevisions.current.speechModel === sentRevision) {
        edited.current.delete("speechModel");
        setSpeechModel(saved.speechModel);
      }
      setCredentials(update);
      await keepCredentials(update, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not save that speech model`));
    } finally {
      if (action.current()) {
        speechModelSave.current = null;
        markPending(null);
      }
    }
  }

  async function testVoice() {
    if (!speaker.canSpeak() || pending) return;
    const action = beginMutation("test");
    if (!action) return;
    setError(null);
    setNotice(null);
    try {
      await speaker.speak(t`Hi, this is how I'll sound when I read replies out loud.`, {
        spaceId,
        scope,
      });
      if (!action.current() || !speaker.canSpeak()) return;
      if (speaker.state.error) {
        setError(speaker.state.error);
        return;
      }
      setNotice(t`If you heard that, voice is ready.`);
    } catch (err) {
      if (action.current()) setError(errorText(err, t`Could not play a test clip`));
    } finally {
      if (action.current()) markPending(null);
    }
  }

  const content = (
    <>
      {loading && !catalog.length ? (
        <div className="grid place-items-center py-10">
          <Spinner
            className="size-5 text-muted-foreground"
            aria-label={t`Loading voice providers…`}
          />
        </div>
      ) : null}
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="mb-4 text-sm text-success">{notice}</p> : null}
      {catalog.length ? (
        <Field>
          <FieldLabel htmlFor={providerSelectId}>
            <Trans>Provider</Trans>
          </FieldLabel>
          <NativeSelect
            id={providerSelectId}
            className="w-full"
            value={provider}
            disabled={busy}
            onChange={(event) => void chooseProvider(event.target.value)}
          >
            {catalog.map((entry) => {
              const connected = credentials.some((cred) => cred.provider === entry.id);
              return (
                <NativeSelectOption key={entry.id} value={entry.id}>
                  {entry.name}
                  {connected ? ` (${t`Connected`})` : ""}
                </NativeSelectOption>
              );
            })}
          </NativeSelect>
        </Field>
      ) : null}
      {hiddenSelfHosted && scope === "account" ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void disconnectProvider(OPENAI_COMPATIBLE_PROVIDER_ID)}
        >
          <Trans>Disconnect Self-hosted</Trans>
        </Button>
      ) : null}
      {selected ? (
        <>
          {managesConnection ? (
            <>
              {selfHosted ? (
                <Field className="mt-5">
                  <FieldLabel htmlFor={baseUrlId}>
                    <Trans>Server URL</Trans>
                  </FieldLabel>
                  <Input
                    id={baseUrlId}
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    value={baseUrl}
                    onChange={(event) => {
                      changed("baseUrl");
                      setBaseUrl(event.target.value);
                    }}
                    placeholder="http://192.168.1.10:8880/v1"
                  />
                </Field>
              ) : null}
              {keyless ? null : (
                <Field className="mt-5">
                  <FieldLabel htmlFor={apiKeyId}>
                    <Trans>API key</Trans>
                  </FieldLabel>
                  <Input
                    id={apiKeyId}
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => {
                      apiKeyRevision.current++;
                      setApiKey(event.target.value);
                    }}
                    placeholder={
                      selfHosted
                        ? t`Optional`
                        : credential
                          ? t`Paste a replacement key`
                          : t`Paste your API key`
                    }
                  />
                </Field>
              )}
              {selfHosted ? (
                <>
                  <Field className="mt-5">
                    <FieldLabel htmlFor={ttsModelId}>
                      <Trans>Speech model</Trans>
                    </FieldLabel>
                    <Input
                      id={ttsModelId}
                      autoComplete="off"
                      spellCheck={false}
                      value={ttsModel}
                      maxLength={200}
                      onChange={(event) => {
                        changed("ttsModel");
                        setTtsModel(event.target.value);
                      }}
                      placeholder={DEFAULT_COMPATIBLE_TTS_MODEL}
                    />
                  </Field>
                  <Field className="mt-5">
                    <FieldLabel htmlFor={sttModelId}>
                      <Trans>Transcription model</Trans>
                    </FieldLabel>
                    <Input
                      id={sttModelId}
                      autoComplete="off"
                      spellCheck={false}
                      value={sttModel}
                      maxLength={200}
                      onChange={(event) => {
                        changed("sttModel");
                        setSttModel(event.target.value);
                      }}
                      placeholder={DEFAULT_COMPATIBLE_STT_MODEL}
                    />
                  </Field>
                </>
              ) : null}
              {keyless && credential ? null : (
                <Button
                  type="button"
                  className="mt-3"
                  disabled={busy || !canConnect}
                  onClick={() => void connectKey()}
                >
                  {pending === "connect" ? (
                    <Trans>Connecting…</Trans>
                  ) : credential && selfHosted ? (
                    <Trans>Reconnect</Trans>
                  ) : credential ? (
                    <Trans>Replace key</Trans>
                  ) : (
                    <Trans>Connect</Trans>
                  )}
                </Button>
              )}
              {credential ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={busy}
                  onClick={() => void disconnectProvider()}
                >
                  {pending === "disconnect" ? (
                    <Trans>Disconnecting…</Trans>
                  ) : (
                    <Trans>Disconnect</Trans>
                  )}
                </Button>
              ) : null}
            </>
          ) : null}

          {credential ? (
            <>
              <Field className="mt-6">
                <FieldLabel htmlFor={voiceSelectId}>
                  <Trans>Voice</Trans>
                </FieldLabel>
                {selfHosted ? (
                  <>
                    <Input
                      id={voiceSelectId}
                      list={`${voiceSelectId}-list`}
                      className="w-full"
                      value={voiceId}
                      disabled={busy}
                      onChange={(event) => {
                        changed("voiceId");
                        setVoiceId(event.target.value);
                      }}
                      onBlur={() => {
                        const next = voiceId.trim();
                        if (next && next !== credential?.voiceId) void chooseVoice(next);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        event.currentTarget.blur();
                      }}
                    />
                    <datalist id={`${voiceSelectId}-list`}>
                      {voiceOptions.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                          {voice.description ? ` (${voice.description})` : ""}
                        </option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <NativeSelect
                    id={voiceSelectId}
                    className="w-full"
                    value={voiceId}
                    disabled={busy}
                    onChange={(event) => void chooseVoice(event.target.value)}
                  >
                    {voiceOptions.map((voice) => (
                      <NativeSelectOption key={voice.id} value={voice.id}>
                        {voice.label}
                        {voice.description ? ` (${voice.description})` : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              {selected.id === "fish-audio" ? (
                <Field className="mt-6">
                  <FieldLabel htmlFor={speechModelId}>
                    <Trans>Speech model</Trans>
                  </FieldLabel>
                  <Input
                    id={speechModelId}
                    value={speechModel}
                    maxLength={64}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    placeholder={t`Optional`}
                    onChange={(event) => {
                      changed("speechModel");
                      setSpeechModel(event.target.value);
                    }}
                    onBlur={() => void saveSpeechModel()}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      event.currentTarget.blur();
                    }}
                  />
                </Field>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="mt-4"
                disabled={busy || !status?.ready || !canPreview}
                onClick={() => void testVoice()}
              >
                {pending === "test" ? <Trans>Playing…</Trans> : <Trans>Hear a sample</Trans>}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );

  if (embedded) {
    return <div data-testid="voice-settings">{content}</div>;
  }

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (busy) {
          details.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogContent
        data-testid="voice-settings"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex h-[min(680px,calc(100%-2rem))] w-[920px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:h-[min(680px,calc(100%-5rem))] sm:max-w-[calc(100%-5rem)]"
      >
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <DialogTitle className="text-heading2 font-medium text-foreground">
            <Trans>Voice</Trans>
          </DialogTitle>
          <DialogClose
            aria-label={t`Close voice settings`}
            disabled={busy}
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <XIcon />
          </DialogClose>
        </div>
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="max-w-xl">{content}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function selectedProvider(
  catalog: VoiceCatalogEntry[],
  preferred: Array<string | null | undefined>,
): string {
  return preferred.find((id) => catalog.some((entry) => entry.id === id)) ?? catalog[0]?.id ?? "";
}

const NO_VOICES: VoiceInfo[] = [];

type EditableField = "voiceId" | "speechModel" | "baseUrl" | "ttsModel" | "sttModel";
