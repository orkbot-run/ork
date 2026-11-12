// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import type { ModelApiProtocol } from "@orkbot/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@orkbot/contracts";
import {
  hasModelConnection,
  modelConnectionOptions,
  workspaceApiModels,
  workspaceApiProviders,
} from "@orkbot/core";
import { fetchFresh } from "@orkbot/core/query";
import { isCancelledError, useQuery } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { ModelProviders } from "../../components/model-providers";
import type { ConnectableProvider, ModelConnectIntent } from "../../components/model-role-settings";
import { ModelRoleSettings } from "../../components/model-role-settings";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "../../components/settings-group";
import { SpaceBotsModel } from "../../components/space-bots-model";
import type { MobileBot, MobileModel, MobileModelCredential } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { ModelConnectionRequest } from "../../lib/model-connection-request";
import { closeModelConnection, openModelConnection } from "../../lib/model-connection-request";
import type { ModelPickerRequest } from "../../lib/model-picker-selection";
import { closeModelPicker, openModelPicker } from "../../lib/model-picker-selection";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { captureSettingsContext, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

const noModels: MobileModel[] = [];
const noCredentials: MobileModelCredential[] = [];
const noBots: MobileBot[] = [];

/**
 * The main and approval model lists; connecting a provider opens its own screen. Opened with a
 * Space, it edits that Space's override instead of the account's.
 */
export default function Models() {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  const owner = useMemo(() => captureSettingsContext(target), [target]);
  const rpc = owner.send;
  const mounted = useRef(true);
  const current = useCallback(() => mounted.current && owner.isCurrent(), [owner]);
  // A Space's override is read from that Space even when another one is selected.
  const spaceId = target.scope === "space" ? target.spaceId : undefined;
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createModelsStyles);
  const router = useRouter();
  const { t } = useI18n();
  const me =
    useQuery({ ...rpcQuery("me", undefined, spaceId), enabled: false }, queryClient).data ?? null;
  const catalog =
    useQuery({ ...rpcQuery("models/list", undefined, spaceId), enabled: false }, queryClient)
      .data ?? noModels;
  const credentials =
    useQuery(
      {
        ...rpcQuery("models/credentials", undefined, spaceId),
        enabled: false,
      },
      queryClient,
    ).data ?? noCredentials;
  const workspacePolicy = useQuery(
    { ...rpcQuery("models/workspacePolicy", undefined, spaceId), enabled: false },
    queryClient,
  ).data;
  const bots =
    useQuery({ ...rpcQuery("bots/list", undefined, spaceId), enabled: false }, queryClient).data ??
    noBots;
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const openedRef = useRef(false);
  const pickerRequestRef = useRef<string | null>(null);
  const connectionRequestRef = useRef<string | null>(null);
  const returningFromPickerRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (pickerRequestRef.current) closeModelPicker(pickerRequestRef.current);
      if (connectionRequestRef.current) closeModelConnection(connectionRequestRef.current);
    };
  }, [owner]);

  /** Opening shares a read already in flight; after a change, the answer must come from a new one. */
  const load = useCallback(
    async (reuse = false) => {
      try {
        if (!current()) return;
        const read = (
          path:
            | "me"
            | "models/list"
            | "models/credentials"
            | "bots/list"
            | "models/workspacePolicy",
        ) =>
          fetchFresh(
            queryClient,
            {
              queryKey: rpcQuery(path, undefined, spaceId).queryKey,
              queryFn: () => rpc(path),
            },
            { reuse },
          );
        await Promise.all([
          read("me"),
          read("models/list"),
          read("models/credentials"),
          read("models/workspacePolicy"),
          read("bots/list").catch(() => undefined),
        ]);
        if (!current()) return;
        setLoadError(null);
      } catch (err) {
        // A newer read replaced this one and reports for both.
        if (current() && !isCancelledError(err))
          setLoadError(errorText(err, t("Could not load model settings")));
      }
    },
    [spaceId, t, rpc, current],
  );

  useFocusEffect(
    useCallback(() => {
      // A picker pick saves through the list itself; only connections change what loads here.
      if (returningFromPickerRef.current) returningFromPickerRef.current = false;
      else {
        void load(!openedRef.current);
        openedRef.current = true;
      }
    }, [load]),
  );

  /** A picker reopened after connecting returns to a list that must reload its connections. */
  function pickerRoute(request: ModelPickerRequest): Href {
    if (pickerRequestRef.current) closeModelPicker(pickerRequestRef.current);
    const requestId = openModelPicker(request);
    pickerRequestRef.current = requestId;
    returningFromPickerRef.current = false;
    return { pathname: "/model-picker", params: { requestId } };
  }

  function pushModelPicker(request: ModelPickerRequest) {
    if (!current()) return;
    router.push(pickerRoute(request));
    returningFromPickerRef.current = true;
  }

  function connectionRoute(request: ModelConnectionRequest): Href | undefined {
    if (!current()) return undefined;
    if (connectionRequestRef.current) closeModelConnection(connectionRequestRef.current);
    const requestId = openModelConnection(request);
    connectionRequestRef.current = requestId;
    returningFromPickerRef.current = false;
    return { pathname: "/model-connection", params: { requestId } };
  }

  // Connecting from a picker always adds a connection.
  const connectRoute = (provider: ConnectableProvider, intent: ModelConnectIntent) =>
    connectionRoute({
      provider: provider.id,
      baseUrl: provider.baseUrl,
      apiProtocol: provider.apiProtocol,
      credentialId: null,
      target,
      ...intent,
    });
  const manage = (credential: MobileModelCredential) => {
    const route = connectionRoute({
      provider: credential.provider,
      credentialId: credential.id,
      makeDefault: false,
      target,
    });
    if (route && current()) router.push(route);
  };

  const allProviders = useMemo(() => modelConnectionOptions(catalog), [catalog]);
  const providers = useMemo(
    () => allProviders.filter((option) => !hasModelConnection(option, credentials)),
    [allProviders, credentials],
  );

  const providerKey = (provider: ConnectableProvider) =>
    `connect:${provider.id}:${provider.baseUrl ?? ""}`;
  /** Adds a connection, even for a provider that has one, without touching any list. */
  function addProvider() {
    pushModelPicker({
      title: t("Add provider"),
      selectedKey: "",
      choices: allProviders.map((provider) => ({
        key: providerKey(provider),
        label: provider.name,
        modelLabel: provider.name,
      })),
      onSelect: () => undefined,
      continueTo: (choice) => {
        const provider = allProviders.find((entry) => providerKey(entry) === choice.key);
        return provider
          ? connectionRoute({
              provider: provider.id,
              baseUrl: provider.baseUrl,
              apiProtocol: provider.apiProtocol,
              credentialId: null,
              makeDefault: false,
              target,
            })
          : undefined;
      },
    });
  }

  async function changeConnection(action: () => Promise<unknown>, failure: string) {
    try {
      if (!current()) return;
      await action();
      if (!current()) return;
      setError(null);
    } catch (err) {
      if (!current()) return;
      setError(errorText(err, failure));
    }
    await load();
  }

  // Only the first visit waits; a revisit paints what it saw last and refreshes behind it.
  if (!me && !loadError) {
    return (
      <SafeAreaView edges={["bottom"]} style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </SafeAreaView>
    );
  }

  const failure = error ?? loadError;
  const shownError = error ?? (me ? loadError : null);
  const shared = {
    credentials,
    providers,
    openPicker: pushModelPicker,
    pickerRoute,
    connectRoute,
    onManage: manage,
    userId: me?.userId ?? "",
    spaceId: target.scope === "space" ? target.spaceId : (me?.spaceId ?? ""),
    scope: target.scope,
  };
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {failure && !me ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              void load();
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        {workspacePolicy && (workspacePolicy.canManage || workspacePolicy.policy) ? (
          <MobileWorkspaceModelPolicy
            value={workspacePolicy}
            catalog={catalog}
            openPicker={pushModelPicker}
            rpc={rpc}
            onChanged={() => load()}
          />
        ) : null}
        {me && workspacePolicy && !workspacePolicy.policy ? (
          <>
            <ModelRoleSettings
              {...shared}
              modelRole="main"
              title={t("Main model")}
              defaultLabel={t("Choose a model")}
              onChanged={() => void load()}
            />
            {me.needsModel ? null : (
              <SpaceBotsModel bots={bots} spaceId={spaceId} onSwitched={() => load()} />
            )}
            <ModelRoleSettings
              {...shared}
              progressive
              modelRole="approval"
              title={t("Approval model")}
              defaultLabel={t("Choose a model")}
            />
            <ModelRoleSettings
              {...shared}
              progressive
              modelRole="computer"
              title={t("Computer-use model")}
              defaultLabel={t("Same as main model")}
            />
            {/* Connections are the account's in every Space, so a Space's override lists only its models. */}
            {target.scope === "account" ? (
              <ModelProviders
                catalog={catalog}
                credentials={credentials}
                onManage={manage}
                onAdd={addProvider}
                onRename={(credential, label) =>
                  void changeConnection(
                    () => rpc("models/rename", { credentialId: credential.id, label }),
                    t("Could not update name"),
                  )
                }
                onDisconnect={(credential) =>
                  void changeConnection(
                    () =>
                      rpc("models/disconnect", {
                        provider: credential.provider,
                        credentialId: credential.id,
                      }),
                    t("Could not disconnect this provider"),
                  )
                }
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function MobileWorkspaceModelPolicy({
  value,
  catalog,
  openPicker,
  rpc,
  onChanged,
}: {
  value: {
    canManage: boolean;
    policy: { provider: string; modelId: string } | null;
    models?: Array<{ provider: string; modelId: string }>;
  };
  catalog: MobileModel[];
  openPicker: (request: ModelPickerRequest) => void;
  rpc: ReturnType<typeof captureSettingsContext>["send"];
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
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
  const styles = useThemedStyles(createModelsStyles);
  const providers = workspaceApiProviders(catalog);
  const models = workspaceApiModels(catalog, provider);
  const routingFields =
    catalog.find((entry) => entry.provider === provider)?.connection?.routingFields ?? [];
  const routingReady = routingFields.every((field) => {
    const value = routing[field.key] ?? "";
    return !value ? !field.required : /^[A-Za-z0-9_-]{1,64}$/.test(value);
  });
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
      const result = await rpc("models/probeOpenAiCompatible", {
        baseUrl: baseUrl.trim(),
        apiKey,
        apiProtocol,
        headers: {},
      });
      if (version === probeVersion.current) setFoundModels(result.models);
    } catch {
      if (version === probeVersion.current) setError(t("Could not load model settings"));
    } finally {
      if (version === probeVersion.current) setFinding(false);
    }
  }
  async function save() {
    if (!provider.trim() || !modelId.trim() || !apiKey.trim() || !routingReady || pending) return;
    const key = apiKey;
    setApiKey("");
    setError(null);
    setPending(true);
    try {
      await rpc("models/addWorkspaceModel", {
        provider: provider.trim(),
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
        ...(provider.trim() === OPENAI_COMPATIBLE_PROVIDER_ID
          ? { baseUrl: baseUrl.trim(), apiProtocol, supportsImages }
          : {}),
      });
      await onChanged();
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  async function remove(model: { provider: string; modelId: string }) {
    setPending(true);
    setError(null);
    try {
      await rpc("models/removeWorkspaceModel", model);
      await onChanged();
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ color: native.label, fontWeight: "600", fontSize: 16 }}
      >
        {t("Workspace model")}
      </Text>
      <Text style={{ color: native.secondaryLabel }}>
        {t("Members can use models shared by the workspace owner.")}
      </Text>
      {(value.models?.length ? value.models : value.policy ? [value.policy] : []).map((model) => (
        <View key={`${model.provider}:${model.modelId}`} style={{ gap: 4 }}>
          <Text style={{ color: native.label }}>
            {model.provider} · {model.modelId}
          </Text>
          {value.canManage ? (
            <NativeActionButton
              label={t("Remove")}
              prominence="destructive"
              onPress={() =>
                Alert.alert(
                  t("Remove the workspace model?"),
                  t(
                    "Members will need their own model connection again if no shared models remain.",
                  ),
                  [
                    { text: t("Cancel"), style: "cancel" },
                    { text: t("Remove"), style: "destructive", onPress: () => void remove(model) },
                  ],
                )
              }
            />
          ) : null}
        </View>
      ))}
      {value.canManage && !editing ? (
        <NativeActionButton
          label={t("Add workspace model")}
          onPress={() => {
            setProvider("");
            setModelId("");
            setEditing(true);
          }}
        />
      ) : null}
      {editing && value.canManage ? (
        <>
          <SettingsGroup
            label={t("Workspace model")}
            footer={t("The key cannot be displayed after saving. Enter a new key to replace it.")}
          >
            <SettingsRow
              title={t("Provider")}
              value={providers.find((item) => item.id === provider)?.name ?? t("Choose a provider")}
              chevron="right"
              onPress={() =>
                openPicker({
                  title: t("Provider"),
                  selectedKey: provider,
                  choices: providers.map((item) => ({
                    key: item.id,
                    label: item.name,
                    modelLabel: item.name,
                  })),
                  onSelect: (choice) => {
                    setProvider(choice.key);
                    setModelId("");
                    setRouting({});
                    invalidateProbe();
                  },
                })
              }
            />
            {routingFields.map((field) => (
              <SettingsInputRow
                key={field.key}
                accessibilityLabel={field.label}
                placeholder={field.label}
                value={routing[field.key] ?? ""}
                onChangeText={(value) => setRouting((old) => ({ ...old, [field.key]: value }))}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ))}
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <SettingsInputRow
                accessibilityLabel={t("Model ID")}
                placeholder={t("Model ID")}
                value={modelId}
                onChangeText={setModelId}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : (
              <SettingsRow
                title={t("Model")}
                value={models.find((item) => item.id === modelId)?.label ?? t("Choose a model")}
                chevron="right"
                disabled={!provider}
                onPress={() =>
                  openPicker({
                    title: t("Choose a model"),
                    selectedKey: modelId,
                    choices: models.map((item) => ({
                      key: item.id,
                      label: item.label,
                      modelLabel: item.label,
                    })),
                    onSelect: (choice) => setModelId(choice.key),
                  })
                }
              />
            )}
            {provider.trim() === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <SettingsInputRow
                accessibilityLabel={t("API URL")}
                placeholder={t("API URL")}
                value={baseUrl}
                onChangeText={(value) => {
                  setBaseUrl(value);
                  invalidateProbe();
                }}
                autoCapitalize="none"
                autoCorrect={false}
              />
            ) : null}
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <SettingsRow
                title={t("Protocol")}
                value={apiProtocol}
                chevron="right"
                onPress={() =>
                  openPicker({
                    title: t("Protocol"),
                    selectedKey: apiProtocol,
                    choices: [
                      {
                        key: "chat-completions",
                        label: "Chat Completions",
                        modelLabel: "Chat Completions",
                      },
                      { key: "responses", label: "Responses", modelLabel: "Responses" },
                      {
                        key: "anthropic-messages",
                        label: "Anthropic Messages",
                        modelLabel: "Anthropic Messages",
                      },
                    ],
                    onSelect: (choice) => {
                      setApiProtocol(choice.key as ModelApiProtocol);
                      invalidateProbe();
                    },
                  })
                }
              />
            ) : null}
            {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
              <SettingsRow
                title={t("Model supports images")}
                trailing={
                  <NativeSwitch
                    accessibilityLabel={t("Model supports images")}
                    value={supportsImages}
                    onValueChange={setSupportsImages}
                  />
                }
              />
            ) : null}
            <SettingsInputRow
              accessibilityLabel={t("API key")}
              placeholder={t("API key")}
              value={apiKey}
              onChangeText={(value) => {
                setApiKey(value);
                invalidateProbe();
              }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SettingsGroup>
          {provider === OPENAI_COMPATIBLE_PROVIDER_ID ? (
            <>
              <NativeActionButton
                label={t("Find models")}
                busy={finding}
                disabled={!baseUrl.trim() || !apiKey.trim()}
                onPress={() => void findModels()}
              />
              {[...models, ...foundModels.map((id) => ({ id, label: id }))].length ? (
                <NativeActionButton
                  label={t("Choose a model")}
                  prominence="quiet"
                  onPress={() =>
                    openPicker({
                      title: t("Choose a model"),
                      selectedKey: modelId,
                      choices: [
                        ...new Map(
                          [...models, ...foundModels.map((id) => ({ id, label: id }))].map(
                            (item) => [item.id, item],
                          ),
                        ).values(),
                      ].map((item) => ({
                        key: item.id,
                        label: item.label,
                        modelLabel: item.label,
                      })),
                      onSelect: (choice) => setModelId(choice.key),
                    })
                  }
                />
              ) : null}
            </>
          ) : null}
          <NativeActionButton
            label={t("Save model")}
            busy={pending}
            disabled={!provider.trim() || !modelId.trim() || !apiKey.trim() || !routingReady}
            onPress={() => void save()}
          />
          <NativeActionButton
            label={t("Cancel")}
            prominence="quiet"
            disabled={pending}
            onPress={() => {
              setApiKey("");
              setEditing(false);
              setError(null);
            }}
          />
        </>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function createModelsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      width: "100%",
      padding: 20,
      gap: 24,
      paddingBottom: 40,
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
    },
  });
}
