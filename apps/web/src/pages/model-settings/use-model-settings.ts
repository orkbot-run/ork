// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import { useLingui } from "@lingui/react/macro";
import type {
  Me,
  ModelApiProtocol,
  ModelHeaderRow,
  SettingsScope,
  ThinkingLevel,
} from "@orkbot/contracts";
import {
  compatibleEndpointPreset,
  connectionDisplayName,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  modelHeadersInput,
  normalizeModelRouting,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleProbeSuccessMessage,
  savedCompatibleEndpointMatches,
} from "@orkbot/contracts";
import type { ConnectionFormFields } from "@orkbot/core";
import {
  clampCatalogThinkingLevel,
  compatibleConnectionReady,
  compatibleModelRows,
  compatibleThinkingLevels,
  connectionFormFields,
  connectionFormModelId,
  connectionMaxTokensField,
  createConnectionFormState,
  createModelProbe,
  initialModelProbeState,
  modelConnectRequest,
  popularModelProvidersFirst,
  savedCompatibleModelIds,
} from "@orkbot/core";
import { fetchFresh } from "@orkbot/core/query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import type { ModelPreflightFailure } from "../../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  loadStoredModelAuth,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../../lib/model-connection-preflight";
import { useSpaceQueries } from "../../lib/query";
import { captureRpcContext } from "../../lib/rpc";
import { useBoundSpaceId, useSpaceRpc } from "../../lib/space-rpc";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";
import { errorText } from "../../lib/user-error";

const NO_CATALOG: ModelCatalogEntry[] = [];
const NO_CREDENTIALS: never[] = [];

export type ModelConnectIntent = {
  /** False keeps the current main model; the connection is for a fallback or another role. */
  makeDefault: boolean;
  onConnected?: (choice: {
    provider: string;
    modelId: string;
    credentialId?: string;
  }) => void | Promise<void>;
};

/** `scope` is where a connection made for an empty main model becomes that model. */
export function useModelSettings(onClose: () => void, scope: SettingsScope) {
  const boundClient = useSpaceRpc();
  const boundSpaceId = useBoundSpaceId();
  const owner = useMemo(
    () => captureRpcContext(boundSpaceId ?? undefined),
    [boundClient, boundSpaceId],
  );
  const rpc = owner.client;
  const mounted = useRef(true);
  const ownerRef = useRef(owner);
  const formState = useMemo(
    () =>
      createConnectionFormState(
        () => mounted.current && ownerRef.current === owner && owner.isCurrent(),
      ),
    [owner],
  );
  const intentRef = useRef<ModelConnectIntent | null>(null);
  // A delayed sign-in result belongs to its originating slot and selected form.
  const oauthChoiceRef = useRef<{
    choice: { provider: string; modelId: string };
    intent: ModelConnectIntent | null;
    form: ReturnType<typeof formState.capture>;
  } | null>(null);
  const { t } = useLingui();
  // What the space has is cached, so a revisit paints at once and refreshes behind it.
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const catalogQuery = {
    queryKey: queries.models.list.queryKey(),
    queryFn: () => rpc.models.list(),
  };
  const credentialsQuery = {
    queryKey: queries.models.credentials.queryKey(),
    queryFn: () => rpc.models.credentials(),
  };
  const meQuery = { queryKey: queries.me.queryKey(), queryFn: () => rpc.me() };
  const catalog = useQuery(catalogQuery).data ?? NO_CATALOG;
  const credentials = useQuery(credentialsQuery).data ?? NO_CREDENTIALS;
  const me: Me | null = useQuery(meQuery).data ?? null;
  const [provider, setProvider] = useState("");
  // The connection the dialog edits; null connects a new one.
  const [credentialId, setCredentialIdState] = useState<string | null>(null);
  const credentialIdRef = useRef(credentialId);
  const setCredentialId = (next: string | null) => {
    credentialIdRef.current = next;
    setCredentialIdState(next);
  };
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const [codeCopied, copyOAuthCode] = useCopyText();
  const [loading, setLoading] = useState(
    () =>
      queryClient.getQueryData(catalogQuery.queryKey) === undefined ||
      queryClient.getQueryData(credentialsQuery.queryKey) === undefined ||
      queryClient.getQueryData(meQuery.queryKey) === undefined,
  );
  const [pending, setPending] = useState<"connect" | "settings" | "disconnect" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<
    "api-key" | "sign-in" | "compatible" | null
  >(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const refreshRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectedLabelRef = useRef<string | undefined>(undefined);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    client: rpc,
    isCurrent: () => mounted.current && ownerRef.current === owner && owner.isCurrent(),
    onClearError: () => setError(null),
    onError: (message) => {
      if (oauthChoiceRef.current?.form.isCurrent()) setError(message);
    },
    onFinished: async (_controller, credentialId) => {
      const started = oauthChoiceRef.current;
      if (!started?.form.isSelected()) return;
      setCredentialId(credentialId);
      await refresh({ keepForm: !started.form.isCurrent() });
      if (!started.form.isSelected()) return;
      if (started.form.isCurrent())
        await started.intent?.onConnected?.({ ...started.choice, credentialId });
      if (oauthChoiceRef.current === started) oauthChoiceRef.current = null;
    },
  });

  /**
   * `keepForm` reloads the lists without resetting the open connection's fields. Every refresh but
   * the one on open follows a change, so by default it never reuses a read sent before that change.
   */
  async function refresh({
    keepForm = false,
    reuse = false,
  }: {
    keepForm?: boolean;
    reuse?: boolean;
  } = {}) {
    const form = formState.capture();
    const refreshRevision = ++refreshRevisionRef.current;
    const selectionRevision = keepForm ? -1 : selectionRevisionRef.current;
    const [nextCatalog, nextCredentials, nextMe] = await Promise.all([
      fetchFresh(queryClient, catalogQuery, { reuse }),
      fetchFresh(queryClient, credentialsQuery, { reuse }),
      fetchFresh(queryClient, meQuery, { reuse }),
    ]);
    if (!form.isSelected() || refreshRevision !== refreshRevisionRef.current) return undefined;
    applyLoaded(nextCatalog, nextCredentials, nextMe, form.isCurrent() ? selectionRevision : -1);
    return nextCredentials;
  }

  /** Points the form at the saved choice, unless the user picked something since the load began. */
  function applyLoaded(
    nextCatalog: ModelCatalogEntry[],
    nextCredentials: typeof credentials,
    nextMe: Me,
    selectionRevision: number,
  ) {
    const nextProvider =
      provider && nextCatalog.some((entry) => entry.provider === provider)
        ? provider
        : (nextMe.defaultProvider ?? nextCatalog[0]?.provider ?? "");
    const nextCredential = credentialIdRef.current
      ? nextCredentials.find((entry) => entry.id === credentialIdRef.current)
      : undefined;
    // A connection removed elsewhere leaves the dialog connecting a new one.
    if (credentialIdRef.current && !nextCredential) setCredentialId(null);
    const nextModel = connectionFormModelId({
      catalog: nextCatalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: nextMe,
      current: modelId,
    });
    if (selectionRevision === selectionRevisionRef.current) {
      preflightRevisionRef.current += 1;
      setPreflightSuccess(null);
      setPreflightFailure(null);
      resetOpenAiCompatibleProbe();
      setProvider(nextProvider);
      setModelId(nextModel);
      setHeaderRows(null);
      applyFields(
        connectionFormFields({
          catalog: nextCatalog,
          provider: nextProvider,
          modelId: nextModel,
          credential: nextCredential,
        }),
      );
    }
  }

  function applyFields(fields: ConnectionFormFields) {
    setEnabledModelIds(fields.enabledModelIds);
    setBaseUrl(fields.baseUrl);
    setApiProtocol(fields.apiProtocol);
    setReasoning(fields.reasoning);
    setThinkingLevel(fields.thinkingLevel);
    setMaxTokens(fields.maxTokens);
    setContextWindow(fields.contextWindow);
    setSupportsImages(fields.supportsImages);
    setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
    setRouting(fields.routing);
  }

  useLayoutEffect(() => {
    mounted.current = true;
    ownerRef.current = owner;
    const form = formState.capture();
    const cachedCatalog = queryClient.getQueryData(catalogQuery.queryKey);
    const cachedCredentials = queryClient.getQueryData(credentialsQuery.queryKey);
    const cachedMe = queryClient.getQueryData(meQuery.queryKey);
    // Before paint, so a revisit opens on the saved choice rather than an empty form.
    if (cachedCatalog && cachedCredentials && cachedMe) {
      applyLoaded(cachedCatalog, cachedCredentials, cachedMe, selectionRevisionRef.current);
    }
    void refresh({ reuse: true })
      .catch((err: unknown) => {
        if (form.isCurrent()) setError(errorText(err, t`Could not load model settings`));
      })
      .finally(() => {
        if (form.isSelected()) setLoading(false);
      });
    return () => {
      mounted.current = false;
      refreshRevisionRef.current += 1;
      modelProbe.invalidate();
    };
  }, [owner]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const entry of catalog) {
      const entries = grouped.get(entry.provider) ?? [];
      entries.push(entry);
      grouped.set(entry.provider, entries);
    }
    return popularModelProvidersFirst(
      [...grouped].map(([id, entries]) => ({
        id,
        name: providerDisplayName(
          id,
          entries[0]?.providerName ?? id,
          credentials.find((entry) => entry.provider === id)?.authKind,
        ),
        entries,
      })),
      (group) => group.id,
      (group) => group.name,
    );
  }, [catalog, credentials]);
  const credentialByProvider = useMemo(
    () => new Map(credentials.map((entry) => [entry.provider, entry])),
    [credentials],
  );
  const modelsForProvider = catalog.filter((entry) => entry.provider === provider);
  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  selectedLabelRef.current = selected?.label;
  const selectedProviderName =
    compatibleEndpointPreset(baseUrl, selected?.connection?.presets)?.label ??
    groups.find((group) => group.id === provider)?.name ??
    provider;
  const credential = credentialId
    ? credentials.find((entry) => entry.id === credentialId)
    : undefined;
  const selectedConnectionName = credential
    ? connectionDisplayName(
        credential,
        groups.find((group) => group.id === provider)?.name ?? provider,
        modelsForProvider[0]?.providerName ? [modelsForProvider[0].providerName] : [],
        selected?.connection?.presets,
      )
    : selectedProviderName;
  const disconnectName = selectedConnectionName;
  const hostCredentialSource = me?.hostCredentialSource ?? "";
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const routingFields = selected?.connection?.routingFields ?? [];
  const routingReady = normalizeModelRouting(routingFields, routing) !== undefined;
  const endpointPreset = compatibleEndpointPreset(baseUrl, selected?.connection?.presets);
  const requiresApiKey = endpointPreset?.apiKeyRequired === true;
  const currentEntry = catalog.find(
    (entry) => entry.provider === me?.defaultProvider && entry.id === me?.defaultModel,
  );
  // Space still bills the host while this provider matches; model id alone is not credentials.
  const usingServerCredentials = provider === me?.hostCredentialProvider;
  const acceptsKey = selected?.auth !== "oauth";
  const subscriptionSignIn = selected?.signIn !== undefined;
  // Effort levels for the staged catalog model — "off" stays out, matching the
  // per-bot Thinking picker.
  const catalogThinkingLevels =
    !isOpenAiCompatible && selected
      ? (selected.thinkingLevels ?? []).filter((level) => level !== "off")
      : [];
  const busy = loading || pending !== null || oauthPending;
  const savedHeaderEndpointMatches = savedCompatibleEndpointMatches(baseUrl, credential?.baseUrl);
  const effectiveBaseUrl = baseUrl.trim();
  const openAiCompatibleReady = compatibleConnectionReady({
    apiKey,
    baseUrl,
    modelId,
    headerRows,
    credential,
    connection: selected?.connection,
  });
  const compatibleRows = compatibleModelRows(
    savedCompatibleModelIds(credential, baseUrl),
    enabledModelIds,
    probeModels,
  );
  const defaultModelOptions = [...new Set([...enabledModelIds, modelId])];
  // Saved-connection settings edited without a new key (output limit, gateway ids).
  const settingsDirty =
    !isOpenAiCompatible &&
    Boolean(credential) &&
    (maxTokens.trim() !== connectionMaxTokensField(provider, credential?.maxTokens) ||
      (routingFields.length > 0 &&
        routingFields.some(
          (field) => (routing[field.key] ?? "").trim() !== (credential?.routing?.[field.key] ?? ""),
        )));

  function invalidatePreflight() {
    formState.invalidate();
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return (
      mounted.current &&
      ownerRef.current === owner &&
      owner.isCurrent() &&
      revision === preflightRevisionRef.current
    );
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // A new endpoint starts with no ticks; the saved endpoint gets its saved list back.
    setEnabledModelIds(savedCompatibleModelIds(credential, nextBaseUrl));
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function updateApiKey(nextApiKey: string) {
    setApiKey(nextApiKey);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
  }

  function updateApiProtocol(nextProtocol: ModelApiProtocol) {
    setApiProtocol(nextProtocol);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        thinkingLevel,
        reasoning ? compatibleThinkingLevels(nextProtocol) : [],
      ) as ThinkingLevel | null,
    );
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
  }

  function stageCompatibleModelId(nextModelId: string) {
    invalidatePreflight();
    setModelId(nextModelId);
    setThinkingLevel(
      clampCatalogThinkingLevel(
        credential?.modelId === nextModelId ? credential.thinkingLevel : null,
        reasoning ? compatibleThinkingLevels(apiProtocol) : [],
      ) as ThinkingLevel | null,
    );
  }

  /** Opens a connection (by id) or a new one (null) for the provider. */
  function chooseProvider(
    nextProvider: string,
    presetBaseUrl?: string,
    targetCredentialId: string | null = null,
    presetApiProtocol?: ModelApiProtocol,
  ) {
    cancelOAuthAttempt();
    formState.select();
    setPending(null);
    selectionRevisionRef.current += 1;
    const nextCredential = targetCredentialId
      ? credentials.find((entry) => entry.id === targetCredentialId)
      : undefined;
    setCredentialId(nextCredential?.id ?? null);
    const nextModelId = connectionFormModelId({
      catalog,
      provider: nextProvider,
      credential: nextCredential,
      defaults: me,
    });
    setProvider(nextProvider);
    setModelId(nextModelId);
    applyFields(
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        credential: nextCredential,
        presetBaseUrl,
        presetApiProtocol,
      }),
    );
    setApiKey("");
    setHeaderRows(null);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  async function probeServerModels() {
    if (!baseUrl.trim()) return;
    const revision = preflightRevisionRef.current;
    setError(null);
    setNotice(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setPreflightTarget("compatible");
    await modelProbe.probe({
      baseUrl,
      apiKey,
      request: (input) =>
        rpc.models.probeOpenAiCompatible({
          ...input,
          apiProtocol,
          headers: modelHeadersInput(headerRows),
          credentialId: credential?.id,
        }),
      onSuccess: (models) => {
        if (!preflightStillCurrent(revision)) return;
        const current = modelIdRef.current;
        const next = current.trim() || models[0] || "";
        if (next !== current) stageCompatibleModelId(next);
        else setModelId(next);
        const unavailable = unavailableSelectedModel(current, models);
        if (unavailable) {
          setPreflightFailure(unavailable);
          setNotice(null);
          return;
        }
        setPreflightTarget(null);
        setPreflightFailure(null);
        setNotice(openAiCompatibleProbeSuccessMessage(models.length));
      },
      onError: (err) => {
        if (!preflightStillCurrent(revision)) return;
        setPreflightFailure(classifyModelConnectionFailure(err, { modelId }));
        setNotice(null);
      },
    });
  }

  async function testApiKeyConnection() {
    if (!selected?.catalogProbe) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("api-key");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const result = await runModelConnectionPreflight({
      authKind: "api-key",
      provider: selected.provider,
      apiKey,
      modelId: selected.id,
      catalogProbe: true,
      probeCatalog: rpc.models.probeCatalog,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(modelPreflightSuccessMessage(result.discoveredModels.length));
      return;
    }
    setPreflightFailure(result.failure);
  }

  async function testOAuthConnection() {
    if (!selected) return;
    const revision = preflightRevisionRef.current;
    setPreflightTarget("sign-in");
    setPreflightTesting(true);
    setPreflightSuccess(null);
    setPreflightFailure(null);
    setError(null);
    setNotice(null);
    const stored = await loadStoredModelAuth(
      selected.provider,
      () => rpc.models.credentials(),
      selected.id,
      credentialIdRef.current,
    );
    if (!preflightStillCurrent(revision)) return;
    const result = await runModelConnectionPreflight({
      authKind: "oauth",
      provider: selected.provider,
      ...stored,
    });
    if (!preflightStillCurrent(revision)) return;
    setPreflightTesting(false);
    if (result.ok) {
      setPreflightSuccess(t`A subscription credential is stored securely.`);
      return;
    }
    setPreflightFailure(result.failure);
  }

  // settingsOnly saves a connected catalog provider's limits and gateway ids
  // without touching the key field; key replacement stays on its own button.
  async function connectKey({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
    if (!selected) return;
    // The validated request and its follow-up belong to this selected form.
    const intent = intentRef.current;
    const request = modelConnectRequest({
      form: {
        apiKey,
        modelId,
        enabledModelIds,
        baseUrl,
        apiProtocol,
        headerRows,
        reasoning,
        thinkingLevel,
        maxTokens,
        contextWindow,
        supportsImages,
        maxImagesPerPrompt,
        routing,
      },
      selected,
      credential,
      credentialId: credential?.id ?? null,
      settingsOnly,
      ...(intent ? { makeDefault: { makeDefault: intent.makeDefault, scope } } : {}),
    });
    if (request.status === "incomplete") return;
    if (request.status === "invalid") {
      setError(
        request.field === "maxTokens"
          ? t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`
          : request.field === "maxImagesPerPrompt"
            ? t`Enter a whole number from 1 to 1000 for the image limit.`
            : t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
      );
      return;
    }
    const { input, savingLimitOnly, activeModelId } = request;
    setError(null);
    setNotice(null);
    setPending(settingsOnly ? "settings" : "connect");
    // Opening another connection while this saves leaves that form alone; field edits
    // in this form still adopt the connection the save creates.
    const form = formState.capture();
    const stillSelected = form.isSelected;
    if (!stillSelected()) return;
    try {
      const saved = await rpc.models.connect(input);
      if (!stillSelected()) return;
      // Saving again edits the connection just made instead of adding another.
      if (saved?.id) setCredentialId(saved.id);
      if (!settingsOnly && form.isCurrent()) setApiKey("");
      await refresh({ keepForm: !form.isCurrent() });
      if (!stillSelected()) return;
      if (!settingsOnly && form.isCurrent())
        await intent?.onConnected?.({
          provider: selected.provider,
          modelId: activeModelId,
          credentialId: saved?.id,
        });
      // A fresh connection speaks for itself through the Active model row.
      if (form.isCurrent() && (isOpenAiCompatible || savingLimitOnly)) setNotice(t`Saved.`);
    } catch (err) {
      if (form.isCurrent()) setError(errorText(err, t`Could not connect this provider`));
    } finally {
      if (stillSelected()) setPending(null);
    }
  }

  async function disconnectCredential() {
    if (!selected || !credential) return;
    const form = formState.capture();
    if (!form.isSelected()) return;
    cancelOAuthAttempt();
    setError(null);
    setNotice(null);
    setPending("disconnect");
    try {
      await rpc.models.disconnect({ provider: selected.provider, credentialId: credential.id });
      if (!form.isSelected()) return;
      setCredentialId(null);
      if (!form.isCurrent()) {
        await refresh({ keepForm: true });
        return;
      }
      setApiKey("");
      setThinkingLevel(null);
      await refresh();
      if (form.isCurrent()) setNotice(t`Disconnected ${disconnectName}.`);
    } catch (err) {
      if (form.isCurrent()) setError(errorText(err, t`Could not disconnect this provider`));
    } finally {
      if (form.isSelected()) setPending(null);
    }
  }

  function dismissConnection() {
    formState.select();
    setPending(null);
    cancelOAuthAttempt();
  }

  function handleClose() {
    formState.select();
    cancelOAuthAttempt(false);
    onClose();
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected) return;
    setNotice(null);
    const intent = intentRef.current;
    oauthChoiceRef.current = {
      choice: { provider: selected.provider, modelId: selected.id },
      intent,
      form: formState.capture(),
    };
    void startSubscriptionSignIn({
      provider: selected.provider,
      credentialId: credential?.id ?? null,
      modelId: selected.id,
      ...(intent ? { makeDefault: intent.makeDefault, scope } : {}),
      thinkingLevel: clampCatalogThinkingLevel(
        thinkingLevel,
        selected.thinkingLevels,
      ) as ThinkingLevel | null,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    rpc,
    isCurrent: () => mounted.current && ownerRef.current === owner && owner.isCurrent(),
    intentRef,
    refresh,
    resetOpenAiCompatibleProbe,
    headerRows,
    setHeaderRows: (value: Parameters<typeof setHeaderRows>[0]) => {
      invalidatePreflight();
      setHeaderRows(value);
    },
    savedHeaderEndpointMatches,
    acceptsKey,
    routing,
    routingFields,
    setRouting: (value: Parameters<typeof setRouting>[0]) => {
      invalidatePreflight();
      setRouting(value);
    },
    endpointPreset,
    requiresApiKey,
    apiKey,
    apiProtocol,
    baseUrl,
    beginSelectedSubscriptionSignIn,
    busy,
    cancelOAuthAttempt,
    catalog,
    catalogThinkingLevels,
    chooseProvider,
    routingReady,
    codeCopied,
    compatibleRows,
    confirmDisconnect,
    connectKey,
    contextWindow,
    copyOAuthCode,
    credential,
    credentialByProvider,
    credentials,
    currentEntry,
    defaultModelOptions,
    dismissConnection,
    disconnectCredential,
    disconnectName,
    effectiveBaseUrl,
    enabledModelIds,
    error,
    groups,
    handleClose,
    hostCredentialSource,
    invalidatePreflight,
    isOpenAiCompatible,
    loading,
    maxImagesPerPrompt,
    maxTokens,
    me,
    modelId,
    modelsForProvider,
    notice,
    oauth,
    oauthPending,
    openAiCompatibleReady,
    pasteCode,
    pending,
    popupBlocked,
    preflightFailure,
    preflightSuccess,
    preflightTarget,
    preflightTesting,
    probeModels,
    probeServerModels,
    probing,
    provider,
    reasoning,
    selected,
    selectedConnectionName,
    selectedProviderName,
    selectionRevisionRef,
    setConfirmDisconnect,
    setContextWindow: (value: Parameters<typeof setContextWindow>[0]) => {
      invalidatePreflight();
      setContextWindow(value);
    },
    setEnabledModelIds: (value: Parameters<typeof setEnabledModelIds>[0]) => {
      invalidatePreflight();
      setEnabledModelIds(value);
    },
    setError,
    setMaxImagesPerPrompt: (value: Parameters<typeof setMaxImagesPerPrompt>[0]) => {
      invalidatePreflight();
      setMaxImagesPerPrompt(value);
    },
    setMaxTokens: (value: Parameters<typeof setMaxTokens>[0]) => {
      invalidatePreflight();
      setMaxTokens(value);
    },
    setModelId: (value: Parameters<typeof setModelId>[0]) => {
      invalidatePreflight();
      setModelId(value);
    },
    setNotice,
    setPasteCode,
    setReasoning: (value: Parameters<typeof setReasoning>[0]) => {
      invalidatePreflight();
      setReasoning(value);
    },
    setSupportsImages: (value: Parameters<typeof setSupportsImages>[0]) => {
      invalidatePreflight();
      setSupportsImages(value);
    },
    setThinkingLevel: (value: Parameters<typeof setThinkingLevel>[0]) => {
      invalidatePreflight();
      setThinkingLevel(value);
    },
    settingsDirty,
    stageCompatibleModelId,
    submitOAuthCode,
    subscriptionSignIn,
    supportsImages,
    testApiKeyConnection,
    testOAuthConnection,
    thinkingLevel,
    updateApiKey,
    updateApiProtocol,
    updateBaseUrl,
    usingServerCredentials,
  };
}
export type ModelSettingsState = ReturnType<typeof useModelSettings>;
