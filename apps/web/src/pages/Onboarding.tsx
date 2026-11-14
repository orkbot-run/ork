// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 behavior is preserved. Personal Ork changes follow LICENSE.md.

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ModelApiProtocol, ModelHeaderRow, ThinkingLevel } from "@orkbot/contracts";
import {
  compatibleEndpointPreset,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_TOKENS,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleProbeSuccessMessage,
} from "@orkbot/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionFormFields,
  createConnectionFormState,
  createModelProbe,
  hasModelConnection,
  initialModelProbeState,
  modelConnectionOptions,
  modelConnectRequest,
  pickCatalogModelId,
} from "@orkbot/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@orkbot/ui-web";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AccountMenu } from "../components/AccountMenu";
import { FoundModelPicker } from "../components/FoundModelPicker";
import {
  ModelPreflightFeedback,
  modelPreflightTestingLabel,
} from "../components/ModelConnectionPreflightNotice";
import { PageLoading } from "../components/PageLoading";
import { useCopyText } from "../lib/copy-text";
import type { ModelCatalogEntry } from "../lib/model-auth";
import type { ModelPreflightFailure } from "../lib/model-connection-preflight";
import {
  classifyModelConnectionFailure,
  modelPreflightSuccessMessage,
  runModelConnectionPreflight,
  unavailableSelectedModel,
} from "../lib/model-connection-preflight";
import { captureRpcContext } from "../lib/rpc";
import { useSignOut } from "../lib/sign-out";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";
import { CompatibleKeyField } from "./model-settings/compatible-key-field";
import { ManagedModelSetup } from "./onboarding/managed-model-setup";

const CUSTOM_MODEL_OPTION = "__orkbot_custom_model__";
/** Ork credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__orkbot_credits__";
/** A provider whose catalog entry offers both sign-in and a key appears once per way to connect. */
type ProviderAuth = "sign-in" | "key";

export function OnboardingPage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [owner] = useState(() => captureRpcContext());
  const rpc = owner.client;
  const mounted = useRef(true);
  const [formState] = useState(() =>
    createConnectionFormState(() => mounted.current && owner.isCurrent()),
  );
  const [saving, setSaving] = useState(false);
  const oauthForm = useRef<ReturnType<typeof formState.capture> | null>(null);
  const fieldId = useId();
  // Legacy survey links resolve to the current onboarding step.
  const { step: routeStep } = useParams();
  const linkedStep = routeStep === "model" ? routeStep : undefined;
  const [creatingBot, setCreatingBot] = useState(false);
  const [managed, setManaged] = useState<boolean | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const step = managed === null ? "loading" : creatingBot ? "bot" : (linkedStep ?? "loading");
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [provider, setProvider] = useState("");
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [modelId, setModelId] = useState("");
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const [apiKey, setApiKey] = useState("");
  const [routing, setRouting] = useState<Record<string, string>>({});
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>("chat-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [headerRows, setHeaderRows] = useState<ModelHeaderRow[] | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MODEL_MAX_TOKENS));
  const [contextWindow, setContextWindow] = useState(String(DEFAULT_MODEL_CONTEXT_WINDOW));
  const [supportsImages, setSupportsImages] = useState(false);
  const [maxImagesPerPrompt, setMaxImagesPerPrompt] = useState("");
  const [{ models: probeModels, probing }, setProbe] = useState(initialModelProbeState);
  const [modelProbe] = useState(() => createModelProbe(setProbe));
  const resetOpenAiCompatibleProbe = modelProbe.reset;
  const createStartedRef = useRef(false);
  const createAttemptRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut("/sign-in", setError);
  const [notice, setNotice] = useState<string | null>(null);
  const [preflightTesting, setPreflightTesting] = useState(false);
  const [preflightTarget, setPreflightTarget] = useState<"api-key" | "compatible" | null>(null);
  const [preflightSuccess, setPreflightSuccess] = useState<string | null>(null);
  const [preflightFailure, setPreflightFailure] = useState<ModelPreflightFailure | null>(null);
  const preflightRevisionRef = useRef(0);
  const [codeCopied, copyOAuthCode] = useCopyText();

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
    isCurrent: () => mounted.current && owner.isCurrent(),
    onClearError: () => setError(null),
    onError: (message) => {
      if (oauthForm.current?.isCurrent()) setError(message);
    },
    onFinished: async () => {
      const form = oauthForm.current;
      if (form?.isCurrent()) await continueAfterModel(form.isCurrent);
    },
  });

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const form = formState.capture();
    setError(null);
    void Promise.all([rpc.me(), rpc.models.workspacePolicy()])
      .then(async ([me, policy]) => {
        if (!active || !form.isSelected()) return;
        const models = policy.managed ? [] : await rpc.models.list().catch(() => []);
        if (!active || !form.isSelected()) return;
        setManaged(policy.managed === true);
        setBillingEnabled(me.billingEnabled);
        setCatalog(models);
        const next = me.needsModel ? "model" : "bot";
        if (!linkedStep) goTo(next);
      })
      .catch((err: unknown) => {
        if (active && form.isSelected()) setError(errorText(err, t`Could not load model settings`));
      });
    return () => {
      active = false;
      mounted.current = false;
      modelProbe.invalidate();
    };
  }, [loadRevision]);

  function goTo(next: "model" | "bot") {
    if (!mounted.current || !owner.isCurrent()) return;
    if (next === "bot") setCreatingBot(true);
    navigate(next === "bot" ? "/onboarding" : `/onboarding/${next}`, { replace: true });
  }

  const modelsForProvider = useMemo(
    () => catalog.filter((entry) => entry.provider === provider),
    [catalog, provider],
  );

  const selected = modelsForProvider.find((entry) => entry.id === modelId) ?? modelsForProvider[0];
  const isOpenAiCompatible = provider === OPENAI_COMPATIBLE_PROVIDER_ID;
  const routingFields = selected?.connection?.routingFields ?? [];
  const endpointPreset = compatibleEndpointPreset(baseUrl, selected?.connection?.presets);
  const requiresApiKey = endpointPreset?.apiKeyRequired === true;
  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const connectionRequest = selected
    ? modelConnectRequest({
        form: {
          apiKey,
          modelId,
          enabledModelIds: [],
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
        credentialId: null,
        makeDefault: { makeDefault: true, scope: "account" },
      })
    : null;
  const canSaveModel = Boolean(
    connectionRequest &&
      connectionRequest.status !== "incomplete" &&
      !oauthPending &&
      (isOpenAiCompatible || acceptsKey),
  );
  const providerOptions = useMemo(() => {
    const main = modelConnectionOptions(catalog).flatMap((option, index) => {
      const entry = catalog.find((item) => item.provider === option.id)!;
      const modes: Array<ProviderAuth | undefined> =
        !option.baseUrl && entry.auth === "both" && entry.signIn ? ["sign-in", "key"] : [undefined];
      return modes.map((auth) => ({
        ...option,
        provider: option.id,
        auth,
        value: `provider:${index}:${auth ?? "default"}`,
        label: auth
          ? `${option.name} (${auth === "key" ? t`API key` : (entry.oauthLabel ?? t`Sign in`)})`
          : option.name,
      }));
    });
    return { main, rest: [] as typeof main };
  }, [catalog, t]);
  const providerItems = useMemo(
    () => [
      ...(billingEnabled ? [{ value: CREDITS_OPTION, label: t`Ork credits` }] : []),
      ...providerOptions.main,
    ],
    [billingEnabled, providerOptions, t],
  );
  const selectedProviderOption = providerOptions.main.find(
    (option) =>
      option.provider === provider &&
      option.auth === providerAuth &&
      (option.baseUrl ? hasModelConnection(option, [{ provider, baseUrl }]) : !endpointPreset),
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );

  function invalidatePreflight() {
    formState.invalidate();
    preflightRevisionRef.current += 1;
    setPreflightTesting(false);
    setPreflightTarget(null);
    setPreflightSuccess(null);
    setPreflightFailure(null);
  }

  function updateBaseUrl(nextBaseUrl: string) {
    setBaseUrl(nextBaseUrl);
    setHeaderRows(null);
    // Keep Other model… mode across URL edits; only provider change clears it.
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

  function selectProvider(
    nextProvider: string,
    auth?: ProviderAuth,
    presetBaseUrl?: string,
    presetApiProtocol?: ModelApiProtocol,
  ) {
    cancelOAuthAttempt();
    setProvider(nextProvider);
    setProviderAuth(auth);
    setApiKey("");
    setHeaderRows(null);
    const nextModel =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider);
    const fields = connectionFormFields({
      catalog,
      provider: nextProvider,
      modelId: nextModel,
      presetBaseUrl,
      presetApiProtocol,
    });
    setModelId(nextModel);
    setRouting(fields.routing);
    setApiProtocol(fields.apiProtocol);
    setBaseUrl(fields.baseUrl);
    setReasoning(fields.reasoning);
    setThinkingLevel(fields.thinkingLevel);
    setManualModelId(false);
    setSupportsImages(fields.supportsImages);
    setMaxTokens(fields.maxTokens);
    setContextWindow(fields.contextWindow);
    setMaxImagesPerPrompt(fields.maxImagesPerPrompt);
    resetOpenAiCompatibleProbe();
    invalidatePreflight();
    setError(null);
    setNotice(null);
  }

  function preflightStillCurrent(revision: number): boolean {
    return mounted.current && owner.isCurrent() && revision === preflightRevisionRef.current;
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
        }),
      onSuccess: (models) => {
        if (!preflightStillCurrent(revision)) return;
        const trimmed = modelIdRef.current.trim();
        const next = trimmed || models[0] || "";
        if (next !== trimmed) setThinkingLevel(null);
        // Stay in manual entry across re-probes so a typed id that matches a
        // discovered model cannot yank the freeform field back to the Select.
        setManualModelId(
          (wasManual) => wasManual || (Boolean(trimmed) && !models.includes(trimmed)),
        );
        setModelId(next);
        const unavailable = unavailableSelectedModel(trimmed, models);
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

  async function continueAfterModel(stillCurrent: () => boolean) {
    const me = await rpc.me();
    if (!mounted.current || !owner.isCurrent() || !stillCurrent()) return;
    if (managed && me.needsModel) {
      setError(t`Enable a default model for this workspace to continue.`);
      return;
    }
    goTo(me.needsModel ? "model" : "bot");
  }

  async function continueManagedModel() {
    if (saving || !mounted.current || !owner.isCurrent()) return;
    const form = formState.capture();
    setSaving(true);
    setError(null);
    try {
      await continueAfterModel(form.isCurrent);
    } catch (err) {
      if (form.isCurrent()) setError(errorText(err, t`Could not load model settings`));
    } finally {
      if (form.isSelected()) setSaving(false);
    }
  }

  async function saveModel() {
    if (!canSaveModel || saving) return;
    const form = formState.capture();
    if (!form.isSelected()) return;
    setError(null);
    try {
      const request = connectionRequest;
      if (!request || request.status === "incomplete") return;
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
      setSaving(true);
      await rpc.models.connect(request.input);
      if (form.isCurrent()) await continueAfterModel(form.isCurrent);
    } catch (err) {
      if (form.isCurrent()) setError(errorText(err, t`Could not save model`));
    } finally {
      if (form.isSelected()) setSaving(false);
    }
  }

  async function fundWithCredits() {
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding: "credits" });
      if (mounted.current && owner.isCurrent()) window.location.assign("/onboarding");
    } catch {
      if (mounted.current && owner.isCurrent()) setError(t`Could not open billing`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    oauthForm.current = formState.capture();
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  async function createFirstBot() {
    if (createStartedRef.current || !mounted.current || !owner.isCurrent()) return;
    createStartedRef.current = true;
    const attempt = ++createAttemptRef.current;
    setError(null);
    try {
      const bot = await rpc.onboarding.ensureFirstBot();
      if (attempt !== createAttemptRef.current || !mounted.current || !owner.isCurrent()) return;
      if (!bot) {
        navigate("/app", { replace: true });
        return;
      }
      // Onboarding continues conversationally in the thread: greeting first,
      // then the focus choice (immediate for the first bot).
      const started = await rpc.onboarding
        .start({ botId: bot.id })
        .then(() => true)
        .catch(() => false);
      if (attempt !== createAttemptRef.current || !mounted.current || !owner.isCurrent()) return;
      if (started) {
        await rpc.onboarding.promptFocus({ botId: bot.id }).catch(() => undefined);
      }
      if (attempt !== createAttemptRef.current || !mounted.current || !owner.isCurrent()) return;
      navigate(`/app/${bot.id}`);
    } catch (err) {
      if (attempt !== createAttemptRef.current || !mounted.current || !owner.isCurrent()) return;
      createStartedRef.current = false;
      setError(errorText(err, t`Could not create your bot`));
    }
  }

  useEffect(() => {
    if (step !== "bot") return;
    void createFirstBot();
    return () => {
      createAttemptRef.current += 1;
      createStartedRef.current = false;
    };
  }, [step]);

  // Loading, and creating the first bot, both wait on one spinner until the chat opens.
  if ((step === "loading" && !error) || (step === "bot" && !error)) return <PageLoading />;

  return (
    <div className="min-h-full bg-background px-6 py-12" data-orkbot-surface="onboarding">
      <AccountMenu signingOut={signingOut} onLogOut={() => void logOut()} />
      <div className="mx-auto w-full max-w-[560px]">
        {step === "loading" && error ? (
          <div className="grid gap-4">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button variant="outline" onClick={() => setLoadRevision((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {step === "model" && managed ? (
          <ManagedModelSetup
            saving={saving}
            error={error}
            onContinue={() => void continueManagedModel()}
          />
        ) : null}
        {step === "model" && !managed ? (
          <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
            <h1 className="text-2xl font-medium tracking-tight text-foreground">
              <Trans>Connect a model</Trans>
            </h1>
            <div className="mt-8 block text-sm font-medium text-foreground">
              <span>
                <Trans>Provider</Trans>
              </span>
              <Select
                value={credits ? CREDITS_OPTION : (selectedProviderOption?.value ?? null)}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) return;
                  if (value === CREDITS_OPTION) {
                    cancelOAuthAttempt();
                    setProvider("");
                    setProviderAuth(undefined);
                    setCredits(true);
                    setError(null);
                    return;
                  }
                  setCredits(false);
                  const option = providerOptions.main.find((item) => item.value === value);
                  if (option)
                    selectProvider(
                      option.provider,
                      option.auth,
                      option.baseUrl,
                      option.apiProtocol,
                    );
                }}
                items={providerItems}
              >
                <SelectTrigger aria-label={t`Provider`} className="mt-2 w-full">
                  <SelectValue placeholder={t`Choose a provider`} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {billingEnabled ? (
                      <SelectItem value={CREDITS_OPTION}>
                        <Trans>Ork credits</Trans>
                      </SelectItem>
                    ) : null}
                    {providerOptions.main.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  {providerOptions.main.length && providerOptions.rest.length ? (
                    <SelectSeparator />
                  ) : null}
                  <SelectGroup>
                    {providerOptions.rest.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {provider ? (
              <>
                {isOpenAiCompatible ? (
                  <div className="mt-6 block text-sm text-foreground">
                    <label htmlFor={`${fieldId}-base-url`} className="block font-medium">
                      <Trans>Server URL</Trans>
                      <Input
                        id={`${fieldId}-base-url`}
                        value={baseUrl}
                        onChange={(e) => updateBaseUrl(e.target.value)}
                        aria-label={t`OpenAI-compatible server URL`}
                        placeholder="http://127.0.0.1:8000/v1"
                        autoComplete="off"
                        className="mt-2"
                      />
                    </label>
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        disabled={probing || !baseUrl.trim()}
                        onClick={() => void probeServerModels()}
                      >
                        {probing ? <Trans>Finding…</Trans> : <Trans>Find models</Trans>}
                      </Button>
                      {preflightTarget === "compatible" ? (
                        <ModelPreflightFeedback success={null} failure={preflightFailure} />
                      ) : null}
                    </div>
                    <div className="mt-4 block">
                      <span className="font-medium">
                        <Trans>Model</Trans>
                      </span>
                      {probeModels.length && !manualModelId ? (
                        <FoundModelPicker
                          models={probeModels}
                          value={modelId}
                          onChange={(next) => {
                            invalidatePreflight();
                            setManualModelId(next === CUSTOM_MODEL_OPTION);
                            setModelId(next === CUSTOM_MODEL_OPTION ? "" : next);
                          }}
                          otherValue={CUSTOM_MODEL_OPTION}
                        />
                      ) : (
                        <Input
                          value={modelId}
                          onChange={(e) => {
                            setManualModelId(true);
                            setModelId(e.target.value);
                            invalidatePreflight();
                          }}
                          aria-label={t`Model id`}
                          placeholder="exact-model-id"
                          className="mt-2"
                        />
                      )}
                      {probeModels.length && manualModelId ? (
                        <Button
                          variant="link"
                          size="xs"
                          className="mt-2 px-0 text-muted-foreground"
                          onClick={() => {
                            setManualModelId(false);
                            setModelId(probeModels[0] ?? "");
                            invalidatePreflight();
                          }}
                        >
                          <Trans>Use a found model</Trans>
                        </Button>
                      ) : null}
                    </div>
                    <label
                      className="mb-4 block text-sm font-medium text-foreground"
                      htmlFor={`${fieldId}-protocol`}
                    >
                      <Trans>Protocol</Trans>
                      <NativeSelect
                        id={`${fieldId}-protocol`}
                        value={apiProtocol}
                        className="mt-2 w-full"
                        onChange={(event) => {
                          const protocol = event.target.value as ModelApiProtocol;
                          setApiProtocol(protocol);
                          setThinkingLevel(
                            clampCatalogThinkingLevel(
                              thinkingLevel,
                              reasoning ? compatibleThinkingLevels(protocol) : [],
                            ) as ThinkingLevel | null,
                          );
                          resetOpenAiCompatibleProbe();
                          invalidatePreflight();
                        }}
                      >
                        <NativeSelectOption value="chat-completions">
                          <Trans>Chat Completions</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="responses">
                          <Trans>Responses</Trans>
                        </NativeSelectOption>
                        <NativeSelectOption value="anthropic-messages">
                          <Trans>Messages</Trans>
                        </NativeSelectOption>
                      </NativeSelect>
                    </label>
                  </div>
                ) : null}
                {subscriptionSignIn ? (
                  <div className="mt-4">
                    {oauth ? (
                      <div
                        className="rounded-lg border border-border bg-card p-4"
                        aria-live="polite"
                      >
                        {oauth.mode === "auth-url" ? (
                          <>
                            <p className="text-sm text-muted-foreground">
                              <Trans>
                                Sign in at{" "}
                                <a
                                  href={oauth.verificationUri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-foreground underline"
                                >
                                  {new URL(oauth.verificationUri).hostname}
                                </a>
                                , then paste the code here.
                              </Trans>
                            </p>
                            <div className="mt-3 flex items-center gap-2">
                              <Input
                                value={pasteCode}
                                onChange={(e) => setPasteCode(e.target.value)}
                                aria-label={t`Authorization code`}
                                autoComplete="off"
                                spellCheck={false}
                              />
                              <Button
                                disabled={!pasteCode.trim()}
                                onClick={() => void submitOAuthCode()}
                              >
                                <Trans>Submit</Trans>
                              </Button>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">
                              <Plural
                                value={Math.ceil(oauth.expiresInSeconds / 60)}
                                one="Waiting for sign-in — the link expires in about # minute."
                                other="Waiting for sign-in — the link expires in about # minutes."
                              />
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-muted-foreground">
                              {popupBlocked ? (
                                <Trans>
                                  Open{" "}
                                  <a
                                    href={oauth.verificationUri}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-foreground underline"
                                  >
                                    {oauth.verificationUri.replace(/^https:\/\//, "")}
                                  </a>{" "}
                                  and enter this code:
                                </Trans>
                              ) : (
                                <Trans>
                                  A sign-in tab opened at{" "}
                                  <a
                                    href={oauth.verificationUri}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-foreground underline"
                                  >
                                    {oauth.verificationUri.replace(/^https:\/\//, "")}
                                  </a>
                                  . Enter this code there — this window keeps waiting:
                                </Trans>
                              )}
                            </p>
                            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-muted p-4">
                              <p className="flex-1 font-mono text-2xl font-medium tracking-[0.2em] text-foreground">
                                {oauth.userCode}
                              </p>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => copyOAuthCode(oauth.userCode)}
                              >
                                {codeCopied ? (
                                  <Check size={14} strokeWidth={1.8} aria-hidden="true" />
                                ) : (
                                  <Copy size={14} strokeWidth={1.8} aria-hidden="true" />
                                )}
                                {codeCopied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                              </Button>
                            </div>
                            <p
                              className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
                              role="status"
                            >
                              <LoaderCircle
                                className="size-4 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                              <Plural
                                value={Math.ceil(oauth.expiresInSeconds / 60)}
                                one="Waiting for sign-in — the code expires in about # minute."
                                other="Waiting for sign-in — the code expires in about # minutes."
                              />
                            </p>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2 -ml-2 text-muted-foreground"
                          onClick={() => cancelOAuthAttempt()}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                      </div>
                    ) : (
                      <Button
                        disabled={oauthPending}
                        onClick={() => beginSelectedSubscriptionSignIn()}
                      >
                        {oauthPending ? <Trans>Starting…</Trans> : signInLabel}
                      </Button>
                    )}
                  </div>
                ) : null}
                {acceptsKey
                  ? routingFields.map((field) => (
                      <label
                        key={field.key}
                        htmlFor={`${fieldId}-route-${field.key}`}
                        className="mt-4 block text-sm font-medium text-foreground"
                      >
                        {field.label}
                        <Input
                          id={`${fieldId}-route-${field.key}`}
                          value={routing[field.key] ?? ""}
                          required={field.required}
                          onChange={(event) => {
                            setRouting((current) => ({
                              ...current,
                              [field.key]: event.target.value,
                            }));
                            invalidatePreflight();
                          }}
                          autoComplete="off"
                          spellCheck={false}
                          className="mt-2"
                        />
                      </label>
                    ))
                  : null}
                {acceptsKey ? (
                  isOpenAiCompatible ? (
                    <CompatibleKeyField
                      className="mt-4 block text-sm text-muted-foreground"
                      required={requiresApiKey}
                    >
                      <Input
                        aria-label={t`API key`}
                        value={apiKey}
                        onChange={(e) => updateApiKey(e.target.value)}
                        required={requiresApiKey}
                        placeholder={requiresApiKey ? "" : t`Optional`}
                        type="password"
                        autoComplete="new-password"
                        className="mt-2"
                      />
                    </CompatibleKeyField>
                  ) : (
                    <label
                      htmlFor={`${fieldId}-api-key`}
                      className="mt-4 block text-sm font-medium text-foreground"
                    >
                      {subscriptionSignIn ? (
                        <Trans>Or paste an API key</Trans>
                      ) : (
                        <Trans>API key</Trans>
                      )}
                      <Input
                        id={`${fieldId}-api-key`}
                        value={apiKey}
                        onChange={(e) => updateApiKey(e.target.value)}
                        placeholder="sk-…"
                        type="password"
                        autoComplete="new-password"
                        className="mt-2"
                      />
                    </label>
                  )
                ) : null}
                {acceptsKey && !isOpenAiCompatible && selected?.catalogProbe ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3"
                      disabled={preflightTesting || apiKey.trim().length < 8}
                      onClick={() => void testApiKeyConnection()}
                    >
                      {modelPreflightTestingLabel(
                        preflightTesting && preflightTarget === "api-key",
                        "api-key",
                      )}
                    </Button>
                    {preflightTarget === "api-key" ? (
                      <ModelPreflightFeedback
                        success={preflightSuccess}
                        failure={preflightFailure}
                      />
                    ) : null}
                  </>
                ) : null}
                {/* The model is chosen once the account is connected; sign-in uses the default. */}
                {!isOpenAiCompatible && acceptsKey && apiKey.trim() ? (
                  <div className="mt-6 block text-sm text-foreground">
                    <span className="font-medium">
                      <Trans>Model</Trans>
                    </span>
                    <Select
                      value={selected?.id ?? modelId}
                      onValueChange={(value) => {
                        if (typeof value !== "string" || !value) return;
                        if (value === modelId) return;
                        cancelOAuthAttempt();
                        setModelId(value);
                        setThinkingLevel(null);
                        invalidatePreflight();
                      }}
                      items={modelItems}
                    >
                      <SelectTrigger aria-label={t`Model`} className="mt-2 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {modelsForProvider.map((entry) => (
                            <SelectItem key={`${entry.provider}:${entry.id}`} value={entry.id}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </>
            ) : null}
            {notice ? (
              <p className="mt-3 text-sm text-success" role="status">
                {notice}
              </p>
            ) : null}
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            <Button
              className="mt-6"
              disabled={saving || (!credits && !canSaveModel)}
              onClick={() => void (credits ? fundWithCredits() : saveModel())}
            >
              <Trans>Continue</Trans>
            </Button>
          </div>
        ) : null}
        {step === "bot" ? (
          <div>
            <p className="text-sm text-destructive">{error}</p>
            <Button className="mt-4" onClick={() => void createFirstBot()}>
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
