// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache material is preserved; model configuration changes follow LICENSE.md.

import { hasModelConnection, modelConnectionOptions } from "@orkbot/core";
import { fetchFresh } from "@orkbot/core/query";
import { isCancelledError, useQuery } from "@tanstack/react-query";
import type { Href } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { ModelProviders } from "../../components/model-providers";
import type { ConnectableProvider, ModelConnectIntent } from "../../components/model-role-settings";
import { ModelRoleSettings } from "../../components/model-role-settings";
import { ServerAISettings } from "../../components/server-ai-settings";
import { SpaceBotsModel } from "../../components/space-bots-model";
import { WorkspaceModelSettings } from "../../components/workspace-model-settings";
import type { MobileBot, MobileModel, MobileModelCredential } from "../../lib/api";
import { spaceSelectionSeq, subscribeConfirmedSpaceSwitch } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import type { ModelConnectionRequest } from "../../lib/model-connection-request";
import { closeModelConnection, openModelConnection } from "../../lib/model-connection-request";
import type { ModelPickerRequest } from "../../lib/model-picker-selection";
import { closeModelPicker, openModelPicker } from "../../lib/model-picker-selection";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import { currentSessionGeneration, subscribeSessionGeneration } from "../../lib/session";
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
  const session = useSyncExternalStore(
    subscribeSessionGeneration,
    currentSessionGeneration,
    currentSessionGeneration,
  );
  const selection = useSyncExternalStore(
    subscribeConfirmedSpaceSwitch,
    spaceSelectionSeq,
    spaceSelectionSeq,
  );
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  const owner = useMemo(() => captureSettingsContext(target), [target, session, selection]);
  const spaceId = target.scope === "space" ? target.spaceId : undefined;
  const policy = useQuery(
    {
      ...rpcQuery("models/workspacePolicy", undefined, spaceId),
      queryFn: () => owner.send("models/workspacePolicy"),
    },
    queryClient,
  );
  const styles = useThemedStyles(createModelsStyles);
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  if (policy.isPending) return <ActivityIndicator />;
  if (policy.isError)
    return (
      <LoadFailure
        message={t("Could not load model settings")}
        onRetry={() => void policy.refetch()}
      />
    );
  if (!policy.data.managed) return <LegacyModels key={`${session}:${selection}`} />;
  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        <ServerAISettings
          key={`${session}:${selection}`}
          send={owner.send}
          isCurrent={owner.isCurrent}
          spaceId={spaceId}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function LegacyModels() {
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
        {workspacePolicy ? (
          <WorkspaceModelSettings
            key={JSON.stringify([me?.userId, spaceId ?? me?.spaceId])}
            value={workspacePolicy}
            catalog={catalog}
            send={rpc}
            isCurrent={current}
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
