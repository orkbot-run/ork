// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 UI is preserved. Space onboarding follows LICENSE.md.

import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Text, TextInput } from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions } from "../components/sheet-header";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { newSpaceCreation } from "../lib/new-space";
import { refreshOrganizations } from "../lib/organizations";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NewSpace() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createSpace] = useState(newSpaceCreation);
  const creating = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating.current) return;
    creating.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await createSpace(trimmed, () => active.current);
      if (result === "stale") return;
      void refreshOrganizations();
      if (result === "selection_failed") {
        Alert.alert(t("Space created"), t("It could not be opened. Try again from the sidebar."));
        router.dismissAll();
        router.replace("/");
        return;
      }
      router.dismissAll();
      router.replace("/");
    } catch (reason) {
      if (!active.current) return;
      setError(errorText(reason, t("Could not create space")));
      creating.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen options={cancelHeaderOptions(t("Cancel"), () => router.back())} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          autoFocus
          value={name}
          maxLength={60}
          onChangeText={setName}
          onSubmitEditing={() => void create()}
          placeholder={t("Customer support")}
          placeholderTextColor={tokens.mutedForeground}
          returnKeyType="done"
          style={{
            marginTop: 8,
            backgroundColor: native.fill,
            borderRadius: 11,
            padding: 14,
            color: tokens.foreground,
            fontSize: 16,
          }}
        />
        {error ? <Text style={{ color: tokens.destructive, marginTop: 14 }}>{error}</Text> : null}
        <NativeActionButton
          disabled={!name.trim() || pending}
          label={pending ? t("Creating…") : t("Create space")}
          onPress={() => void create()}
          style={{ marginTop: 20 }}
        />
      </ScrollView>
    </>
  );
}
