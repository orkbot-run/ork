// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache material is preserved. Confirmed voice settings changes follow LICENSE.md.

import type { VoiceCatalogEntry, VoiceCredential, VoiceInfo, VoiceStatus } from "@orkbot/contracts";
import {
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@orkbot/contracts";
import { fetchFresh, writeSaved } from "@orkbot/core/query";
import { isCancelledError } from "@tanstack/react-query";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LoadFailure } from "../../components/load-failure";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSwitch } from "../../components/native-switch";
import { Checkmark } from "../../components/row-accessories";
import { mobileTokens } from "../../lib/appearance";
import {
  loadCallSoundsEnabled,
  loadWaitSoundEnabled,
  playCallCue,
  saveCallSoundsEnabled,
  saveWaitSoundEnabled,
} from "../../lib/call-sounds";
import { loadDeviceVoiceEnabled, saveDeviceVoiceEnabled } from "../../lib/device-voice";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { queryClient, rpcQuery } from "../../lib/query";
import type { SettingsTarget } from "../../lib/settings-target";
import { captureSettingsContext, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";
import { canStartSpeech, speakText, subscribeSpeechOwnership } from "../../lib/voice";

type VoiceField = "voiceId" | "speechModel" | "baseUrl" | "ttsModel" | "sttModel";

/** A Space's override is read from that Space even when another one is selected. */
const targetSpace = (target: SettingsTarget) =>
  target.scope === "space" ? target.spaceId : undefined;
const voiceReads = (target: SettingsTarget) => {
  const input = { scope: target.scope };
  const spaceId = targetSpace(target);
  return {
    catalog: rpcQuery("voice/catalog", undefined, spaceId),
    credentials: rpcQuery("voice/credentials", input, spaceId),
    status: rpcQuery("voice/status", input, spaceId),
  };
};
const voicesRead = (target: SettingsTarget, provider: string) =>
  rpcQuery("voice/voices", { provider, scope: target.scope }, targetSpace(target));

function pickProvider(catalog: VoiceCatalogEntry[], status: VoiceStatus, preferred?: string) {
  return (
    [preferred, status.provider].find((id) => catalog.some((entry) => entry.id === id)) ??
    catalog[0]?.id ??
    ""
  );
}

/** What this screen showed last in this space, so a revisit paints it before refreshing. */
function cachedVoiceSettings(target: SettingsTarget) {
  const reads = voiceReads(target);
  const catalog = queryClient.getQueryData(reads.catalog.queryKey);
  const credentials = queryClient.getQueryData(reads.credentials.queryKey);
  const status = queryClient.getQueryData(reads.status.queryKey);
  if (!catalog || !credentials || !status) return null;
  const provider = pickProvider(catalog, status);
  const credential = credentials.find((entry) => entry.provider === provider);
  const voices = credential ? queryClient.getQueryData(voicesRead(target, provider).queryKey) : [];
  return { catalog, credentials, status, provider, credential, voices: voices ?? [] };
}

/**
 * The voice that reads replies out loud. Opened with a Space, it edits that Space's override;
 * this device's voice and sounds stay with the device, so only the account's screen shows them.
 */
export default function VoiceSettings() {
  const params = useLocalSearchParams<{ spaceId?: string }>();
  const target = useMemo(() => settingsTarget(params.spaceId), [params.spaceId]);
  const origin = useMemo(() => captureSettingsContext(target), [target]);
  const rpc = origin.send;
  const live = useRef<typeof origin | null>(origin);
  const previousOrigin = useRef(origin);
  const reads = useMemo(() => voiceReads(target), [target]);
  const mutationRevision = useRef(0);
  const fieldRevisions = useRef<Partial<Record<VoiceField, number>>>({});
  const apiKeyRevision = useRef(0);
  const scope = target.scope;
  const deviceSettings = scope === "account";
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createVoiceStyles);
  const { t } = useI18n();
  const [cached] = useState(() => cachedVoiceSettings(target));
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>(cached?.catalog ?? []);
  const [credentials, setCredentials] = useState<VoiceCredential[]>(cached?.credentials ?? []);
  const [status, setStatus] = useState<VoiceStatus | null>(cached?.status ?? null);
  const [voices, setVoices] = useState<VoiceInfo[]>(cached?.voices ?? []);
  const [provider, setProvider] = useState(cached?.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(cached?.credential?.voiceId ?? "");
  const [speechModel, setSpeechModel] = useState(cached?.credential?.speechModel ?? "");
  const [baseUrl, setBaseUrl] = useState(cached?.credential?.endpoint ?? "");
  const [ttsModel, setTtsModel] = useState(cached?.credential?.ttsModel ?? "");
  const [sttModel, setSttModel] = useState(cached?.credential?.sttModel ?? "");
  // Fields typed into since the last load; an opening refresh keeps them.
  const edited = useRef(new Set<VoiceField>());
  // Every load and action bumps this, so an older refresh never lands over a newer choice.
  const loadRevision = useRef(0);
  const speechModelSave = useRef<string | null>(null);
  const [deviceVoice, setDeviceVoice] = useState(false);
  const [deviceVoiceReady, setDeviceVoiceReady] = useState(!deviceSettings);
  const [callSounds, setCallSounds] = useState<boolean | null>(null);
  const [waitSound, setWaitSound] = useState<boolean | null>(null);
  // Prevent stale reads from overwriting a saved preference.
  const soundPrefsRevision = useRef(0);
  const soundPrefSaving = useRef(false);
  // Only the first visit waits; a revisit paints what it saw last and refreshes behind it.
  const [loading, setLoading] = useState(!cached);
  const [pending, setPending] = useState<
    "connect" | "disconnect" | "voice" | "speech" | "test" | "device-voice" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const deviceVoiceRevision = useRef(0);
  const deviceVoiceSaveInFlight = useRef(false);

  const ownerCurrent = () => live.current === origin && origin.isCurrent();
  const canPreview = useSyncExternalStore(subscribeSpeechOwnership, canStartSpeech, canStartSpeech);
  useLayoutEffect(() => {
    live.current = origin;
    if (previousOrigin.current !== origin) {
      previousOrigin.current = origin;
      speechModelSave.current = null;
      setCatalog([]);
      setCredentials([]);
      setStatus(null);
      setProvider("");
      setVoices([]);
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
      setLoadError(null);
      setLoading(true);
      setPending(null);
    }
    return () => {
      if (live.current === origin) live.current = null;
      loadRevision.current++;
      mutationRevision.current++;
    };
  }, [origin]);
  function beginMutation(kind: NonNullable<typeof pending>) {
    if (!ownerCurrent()) return null;
    const revision = ++mutationRevision.current;
    if (kind !== "test") loadRevision.current++;
    setPending(kind);
    return { current: () => ownerCurrent() && mutationRevision.current === revision };
  }
  function assertCurrent(current: () => boolean) {
    if (!current()) throw new Error("Session changed");
  }
  async function keepCredentials(
    update: (current: VoiceCredential[]) => VoiceCredential[],
    current: () => boolean,
  ) {
    await writeSaved(queryClient, reads.credentials.queryKey, (cached) => {
      assertCurrent(current);
      return update(cached ?? []);
    });
  }
  async function keepStatus(saved: VoiceStatus, current: () => boolean) {
    await writeSaved(queryClient, reads.status.queryKey, () => {
      assertCurrent(current);
      return saved;
    });
  }
  function fillFields(cred: VoiceCredential | undefined, keepForm: boolean) {
    const fields: [VoiceField, (value: string) => void, string | undefined][] = [
      ["voiceId", setVoiceId, cred?.voiceId],
      ["speechModel", setSpeechModel, cred?.speechModel],
      ["baseUrl", setBaseUrl, cred?.endpoint],
      ["ttsModel", setTtsModel, cred?.ttsModel],
      ["sttModel", setSttModel, cred?.sttModel],
    ];
    for (const [field, set, value] of fields)
      if (!keepForm || !edited.current.has(field)) set(value ?? "");
  }
  function refreshAfterSave(nextProvider: string | undefined, current: () => boolean) {
    void load(nextProvider, false, true).catch((err: unknown) => {
      if (current()) setLoadError(errorText(err, t("Could not load voice settings")));
    });
  }

  /**
   * Opening keeps fields typed into meanwhile and may share a read already in flight; after a
   * change, every field takes the server's value from a read sent afterwards.
   */
  const load = useCallback(
    async (nextProvider?: string, opening = false, keepForm = opening) => {
      if (!ownerCurrent()) return;
      const revision = ++loadRevision.current;
      const current = () => ownerCurrent() && revision === loadRevision.current;
      if (!keepForm) edited.current.clear();
      const reuse = { reuse: opening };
      try {
        const [nextCatalog, nextCredentials, nextStatus] = await Promise.all([
          fetchFresh(queryClient, reads.catalog, reuse),
          fetchFresh(queryClient, reads.credentials, reuse),
          fetchFresh(queryClient, reads.status, reuse),
        ]);
        if (!current()) return;
        setLoadError(null);
        const selected = pickProvider(nextCatalog, nextStatus, nextProvider);
        setCatalog(nextCatalog);
        setCredentials(nextCredentials);
        setStatus(nextStatus);
        setProvider(selected);
        const cred = nextCredentials.find((entry) => entry.provider === selected);
        fillFields(cred, keepForm);
        if (cred) {
          const nextVoices = await fetchFresh(queryClient, voicesRead(target, selected), reuse);
          if (current()) setVoices(nextVoices);
        } else setVoices([]);
      } catch (err) {
        if (current()) throw err;
      }
    },
    [target, origin, reads],
  );

  const edit = (field: VoiceField, set: (value: string) => void) => (value: string) => {
    edited.current.add(field);
    fieldRevisions.current[field] = (fieldRevisions.current[field] ?? 0) + 1;
    set(value);
  };

  const open = useCallback(() => {
    void load(undefined, true)
      .catch((err: unknown) => {
        // A newer read replaced this one and reports for both.
        if (ownerCurrent() && !isCancelledError(err))
          setLoadError(errorText(err, t("Could not load voice settings")));
      })
      .finally(() => {
        if (ownerCurrent()) setLoading(false);
      });
  }, [load, t]);

  useFocusEffect(
    useCallback(() => {
      open();
      if (!deviceSettings) return;
      const revision = ++deviceVoiceRevision.current;
      void loadDeviceVoiceEnabled()
        .then((value) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoice(value);
          setDeviceVoiceReady(true);
        })
        .catch((err: unknown) => {
          if (deviceVoiceSaveInFlight.current) return;
          if (deviceVoiceRevision.current !== revision) return;
          setDeviceVoiceReady(true);
          setError(errorText(err, t("Could not load voice settings")));
        });
      const soundRevision = soundPrefsRevision.current;
      void Promise.allSettled([loadCallSoundsEnabled(), loadWaitSoundEnabled()]).then(
        ([calls, waiting]) => {
          if (soundPrefSaving.current || soundPrefsRevision.current !== soundRevision) return;
          setCallSounds(calls.status === "fulfilled" ? calls.value : null);
          setWaitSound(waiting.status === "fulfilled" ? waiting.value : null);
          const failed = [calls, waiting].find((result) => result.status === "rejected");
          if (failed?.status === "rejected") {
            setError(errorText(failed.reason, t("Could not load voice settings")));
          }
        },
      );
    }, [deviceSettings, open, t]),
  );

  /** One sound-switch save at a time; a failed save rolls back only that switch. */
  async function saveSoundPref(
    next: boolean,
    show: (value: boolean) => void,
    save: (value: boolean) => Promise<void>,
  ): Promise<boolean> {
    if (soundPrefSaving.current) return false;
    soundPrefSaving.current = true;
    soundPrefsRevision.current += 1;
    show(next);
    try {
      await save(next);
      return true;
    } catch {
      show(!next);
      setError(t("Could not save that preference"));
      return false;
    } finally {
      soundPrefSaving.current = false;
      soundPrefsRevision.current += 1;
    }
  }

  async function toggleWaitSound(next: boolean) {
    if (waitSound === null) return;
    await saveSoundPref(next, setWaitSound, saveWaitSoundEnabled);
  }

  async function toggleCallSounds(next: boolean) {
    if (callSounds === null) return;
    const saved = await saveSoundPref(next, setCallSounds, saveCallSoundsEnabled);
    // The preview is a courtesy: if it cannot play, the saved choice still stands.
    if (saved && next) await playCallCue("start").catch(() => undefined);
  }

  async function saveDeviceVoice(next: boolean): Promise<boolean> {
    deviceVoiceSaveInFlight.current = true;
    deviceVoiceRevision.current++;
    setDeviceVoice(next);
    try {
      await saveDeviceVoiceEnabled(next);
      return true;
    } catch (err) {
      setDeviceVoice(!next);
      setError(errorText(err, t("Could not save that preference")));
      return false;
    } finally {
      deviceVoiceSaveInFlight.current = false;
      deviceVoiceRevision.current++;
    }
  }

  async function toggleDeviceVoice() {
    if (pending !== null || !deviceVoiceReady) return;
    setPending("device-voice");
    setError(null);
    if (status) setLoadError(null);
    try {
      await saveDeviceVoice(!deviceVoice);
    } finally {
      setPending(null);
    }
  }

  async function chooseProvider(nextProvider: string) {
    if (pending !== null || !deviceVoiceReady) return;
    const action = beginMutation("voice");
    if (!action) return;
    const wasDeviceVoice = deviceVoice;
    const previousProvider = provider;
    setError(null);
    if (status) setLoadError(null);
    try {
      if (deviceSettings && !(await saveDeviceVoice(false))) return;
      if (!action.current()) return;
      setProvider(nextProvider);
      const cred = credentials.find((entry) => entry.provider === nextProvider);
      if (cred?.voiceId && status?.provider !== nextProvider) {
        try {
          const saved = await rpc("voice/setVoice", {
            voiceId: cred.voiceId,
            provider: nextProvider,
            scope,
          });
          if (!action.current()) return;
          setStatus(saved);
          await keepStatus(saved, action.current);
        } catch (err) {
          if (!action.current()) return;
          setProvider(previousProvider);
          if (wasDeviceVoice && !(await saveDeviceVoice(true))) return;
          if (action.current()) setError(errorText(err, t("Could not save that voice")));
          return;
        }
      }
      if (!action.current()) return;
      setApiKey("");
      apiKeyRevision.current++;
      setVoiceId(cred?.voiceId ?? "");
      setSpeechModel(cred?.speechModel ?? "");
      setVoices([]);
      try {
        await load(nextProvider);
      } catch (err) {
        if (action.current()) {
          setVoices([]);
          setLoadError(errorText(err, t("Could not load voice settings")));
        }
      }
    } finally {
      if (action.current()) setPending(null);
    }
  }

  const selected = catalog.find((entry) => entry.id === provider);
  const credential = credentials.find((entry) => entry.provider === provider);
  const hiddenSelfHosted =
    !catalog.some((entry) => entry.id === OPENAI_COMPATIBLE_PROVIDER_ID) &&
    credentials.some((entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID);

  const selfHosted = selected?.id === OPENAI_COMPATIBLE_PROVIDER_ID;
  const keyless = Boolean(selected?.keyless);
  const canConnect = keyless || (selfHosted ? Boolean(baseUrl.trim()) : apiKey.trim().length >= 8);

  async function connect() {
    if (!selected || !canConnect || pending !== null) return;
    const action = beginMutation("connect");
    if (!action) return;
    setError(null);
    if (status) setLoadError(null);
    const sentApiKey = apiKey;
    const sentKeyRevision = apiKeyRevision.current;
    const sentFields = { ...fieldRevisions.current };
    try {
      const saved = await rpc("voice/connect", {
        provider: selected.id,
        scope,
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
        transcribe: saved.transcribe,
        provider: saved.provider,
        voiceId: saved.voiceId,
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
      if (action.current()) refreshAfterSave(selected.id, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t("Could not connect")));
    } finally {
      if (action.current()) setPending(null);
    }
  }

  async function disconnect(providerId = credential?.provider) {
    if (!providerId || pending !== null) return;
    const action = beginMutation("disconnect");
    if (!action) return;
    const sentKeyRevision = apiKeyRevision.current;
    setError(null);
    if (status) setLoadError(null);
    try {
      await rpc("voice/disconnect", { provider: providerId });
      if (!action.current()) return;
      const remove = (current: VoiceCredential[]) =>
        current.filter((entry) => entry.provider !== providerId);
      setCredentials(remove);
      setApiKey((current) => (apiKeyRevision.current === sentKeyRevision ? "" : current));
      if (provider === providerId) {
        fillFields(undefined, true);
        setVoices([]);
      }
      await keepCredentials(remove, action.current);
      if (!action.current()) return;
      await queryClient.cancelQueries({ queryKey: reads.status.queryKey, exact: true });
      if (!action.current()) return;
      if (status?.provider === providerId) {
        setStatus(null);
        queryClient.removeQueries({ queryKey: reads.status.queryKey, exact: true });
      }
      refreshAfterSave(providerId, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t("Could not disconnect")));
    } finally {
      if (action.current()) setPending(null);
    }
  }

  async function saveSpeechModel() {
    if (!credential || selected?.id !== "fish-audio" || pending !== null) return;
    const next = speechModel.trim();
    if (next === (credential.speechModel ?? "") || speechModelSave.current === next) return;
    const action = beginMutation("speech");
    if (!action) return;
    const sentRevision = fieldRevisions.current.speechModel;
    speechModelSave.current = next;
    setError(null);
    if (status) setLoadError(null);
    try {
      const saved = await rpc("voice/setSpeechModel", {
        provider: selected.id,
        scope,
        speechModel: next,
      });
      if (!action.current()) return;
      const merge = (current: VoiceCredential[]) =>
        current.map((entry) => (entry.id === saved.id ? { ...entry, ...saved } : entry));
      if (fieldRevisions.current.speechModel === sentRevision) {
        edited.current.delete("speechModel");
        setSpeechModel(saved.speechModel ?? "");
      }
      setCredentials(merge);
      await keepCredentials(merge, action.current);
      if (action.current()) refreshAfterSave(selected.id, action.current);
    } catch (err) {
      if (action.current()) setError(errorText(err, t("Could not save that speech model")));
    } finally {
      if (action.current()) {
        speechModelSave.current = null;
        setPending(null);
      }
    }
  }

  async function chooseVoice(nextVoiceId: string) {
    if (!credential || pending !== null) return;
    const action = beginMutation("voice");
    if (!action) return;
    fieldRevisions.current.voiceId = (fieldRevisions.current.voiceId ?? 0) + 1;
    const sentRevision = fieldRevisions.current.voiceId;
    edited.current.add("voiceId");
    setVoiceId(nextVoiceId);
    setError(null);
    if (status) setLoadError(null);
    try {
      const saved = await rpc("voice/setVoice", {
        voiceId: nextVoiceId,
        provider: selected?.id,
        scope,
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
      if (action.current()) setError(errorText(err, t("Could not save that voice")));
    } finally {
      if (action.current()) setPending(null);
    }
  }

  async function testVoice() {
    if (!canStartSpeech() || pending !== null) return;
    const action = beginMutation("test");
    if (!action) return;
    setError(null);
    if (status) setLoadError(null);
    try {
      const ready = await speakText(t("Hi, this is how I'll sound when I read replies out loud."), {
        scope,
      });
      if (!action.current() || !canStartSpeech()) return;
      if (!ready) throw new Error(t("Connect a voice provider first."));
    } catch (err) {
      if (action.current()) setError(errorText(err, t("Could not play a sample")));
    } finally {
      if (action.current()) setPending(null);
    }
  }

  const failure = error ?? loadError;
  const shownError = error ?? (status ? loadError : null);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
      >
        {loading || !deviceVoiceReady ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {failure && !status ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setLoadError(null);
              setLoading(true);
              open();
            }}
          />
        ) : shownError ? (
          <Text style={styles.error}>{shownError}</Text>
        ) : null}
        {deviceSettings ? (
          <View style={styles.group}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: deviceVoice }}
              disabled={pending !== null || !deviceVoiceReady}
              onPress={() => void toggleDeviceVoice()}
              style={({ pressed }) => [
                styles.groupRow,
                (pending !== null || !deviceVoiceReady) && styles.disabled,
                pressed && styles.pressed,
              ]}
            >
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("This device")}</Text>
              </View>
              {deviceVoice ? <Checkmark /> : null}
            </Pressable>
          </View>
        ) : null}
        {catalog.length ? (
          <View style={styles.group}>
            {catalog.map((entry, index) => {
              const chosen = deviceVoiceReady && !deviceVoice && provider === entry.id;
              return (
                <Pressable
                  key={entry.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: chosen }}
                  disabled={pending !== null || !deviceVoiceReady}
                  onPress={() => void chooseProvider(entry.id)}
                  style={({ pressed }) => [
                    styles.groupRow,
                    index > 0 && styles.groupDivider,
                    (pending !== null || !deviceVoiceReady) && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.rowCopy}>
                    <Text style={styles.cardTitle}>{entry.name}</Text>
                  </View>
                  {chosen ? <Checkmark /> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {/* Connections belong to the account, so a space never removes them. */}
        {hiddenSelfHosted && scope === "account" ? (
          <NativeActionButton
            label={t("Disconnect Self-hosted")}
            prominence="quiet"
            disabled={pending !== null}
            onPress={() => void disconnect(OPENAI_COMPATIBLE_PROVIDER_ID)}
          />
        ) : null}
        {selected && deviceVoiceReady && !deviceVoice ? (
          <>
            {selfHosted ? (
              <TextInput
                accessibilityLabel={t("Server URL")}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                inputMode="url"
                keyboardType="url"
                value={baseUrl}
                onChangeText={edit("baseUrl", setBaseUrl)}
                placeholder="http://192.168.1.10:8880/v1"
                placeholderTextColor={native.tertiaryLabel}
                style={styles.input}
                textContentType="URL"
              />
            ) : null}
            {keyless ? null : (
              <TextInput
                accessibilityLabel={t("API key")}
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                importantForAutofill="no"
                value={apiKey}
                onChangeText={(value) => {
                  apiKeyRevision.current++;
                  setApiKey(value);
                }}
                placeholder={
                  selfHosted
                    ? t("Optional")
                    : credential
                      ? t("Paste a replacement key")
                      : t("Paste your API key")
                }
                placeholderTextColor={native.tertiaryLabel}
                secureTextEntry
                style={styles.input}
                textContentType="none"
              />
            )}
            {selfHosted ? (
              <>
                <Text style={styles.fieldLabel}>{t("Speech model")}</Text>
                <TextInput
                  accessibilityLabel={t("Speech model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={ttsModel}
                  onChangeText={edit("ttsModel", setTtsModel)}
                  placeholder={DEFAULT_COMPATIBLE_TTS_MODEL}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
                <Text style={styles.fieldLabel}>{t("Transcription model")}</Text>
                <TextInput
                  accessibilityLabel={t("Transcription model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={sttModel}
                  onChangeText={edit("sttModel", setSttModel)}
                  placeholder={DEFAULT_COMPATIBLE_STT_MODEL}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
              </>
            ) : null}
            {keyless && credential ? null : (
              <NativeActionButton
                disabled={pending !== null || !canConnect}
                label={
                  credential && selfHosted
                    ? t("Reconnect")
                    : credential
                      ? t("Replace key")
                      : t("Connect")
                }
                onPress={() => void connect()}
              />
            )}
            {credential && scope === "account" ? (
              <NativeActionButton
                disabled={pending !== null}
                label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
                onPress={() => void disconnect()}
                prominence="destructive"
              />
            ) : null}
            {credential && selected.id === "fish-audio" ? (
              <>
                <Text style={styles.fieldLabel}>{t("Speech model")}</Text>
                <TextInput
                  accessibilityLabel={t("Speech model")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={pending === null}
                  value={speechModel}
                  onChangeText={edit("speechModel", setSpeechModel)}
                  onBlur={() => void saveSpeechModel()}
                  onSubmitEditing={() => void saveSpeechModel()}
                  placeholder={t("Optional")}
                  placeholderTextColor={native.tertiaryLabel}
                  style={styles.input}
                />
              </>
            ) : null}
            {voices.length ? (
              <View style={[styles.group, styles.voices]}>
                {voices.map((voice, index) => (
                  <Pressable
                    key={voice.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: voiceId === voice.id }}
                    disabled={pending !== null}
                    onPress={() => void chooseVoice(voice.id)}
                    style={({ pressed }) => [
                      styles.groupRow,
                      index > 0 && styles.groupDivider,
                      pending !== null && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.voiceLabel}>{voice.label}</Text>
                    {voiceId === voice.id ? <Checkmark /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
        {deviceSettings && (deviceVoice || status?.ready) ? (
          <NativeActionButton
            disabled={pending !== null || !canPreview}
            label={t("Hear a sample")}
            onPress={() => void testVoice()}
          />
        ) : null}
        {deviceSettings ? (
          <View style={styles.group}>
            <View style={styles.groupRow}>
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("Call sounds")}</Text>
              </View>
              <NativeSwitch
                accessibilityLabel={t("Call sounds")}
                value={callSounds === true}
                disabled={callSounds === null}
                onValueChange={(next) => void toggleCallSounds(next)}
              />
            </View>
            <View style={[styles.groupRow, styles.groupDivider]}>
              <View style={styles.rowCopy}>
                <Text style={styles.cardTitle}>{t("Waiting sound")}</Text>
              </View>
              <NativeSwitch
                accessibilityLabel={t("Waiting sound")}
                value={waitSound === true}
                disabled={waitSound === null}
                onValueChange={(next) => void toggleWaitSound(next)}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createVoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    group: { borderRadius: 14, backgroundColor: native.fill, overflow: "hidden" },
    groupRow: {
      minHeight: 52,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    groupDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: native.separator,
    },
    rowCopy: { flex: 1 },
    cardTitle: { color: native.label, fontSize: 16 },
    fieldLabel: { color: native.label, marginTop: 16 },
    input: {
      marginTop: 8,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    disabled: { opacity: 0.4 },
    pressed: { opacity: 0.7 },
    voices: { marginTop: 12 },
    voiceLabel: { flex: 1, color: native.label, fontSize: 16 },
  });
}
