// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import {
  getHapticsEnabled,
  loadHapticsEnabled,
  saveHapticsEnabled,
  subscribeHaptics,
} from "../lib/haptics";
import { useI18n } from "../lib/i18n";
import { SettingsSwitch } from "./settings-group";

export function HapticsSetting() {
  const { t } = useI18n();
  const enabled = useSyncExternalStore(subscribeHaptics, getHapticsEnabled);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void loadHapticsEnabled();
    return () => {
      mounted.current = false;
    };
  }, []);
  async function change(value: boolean) {
    setSaving(true);
    try {
      await saveHapticsEnabled(value);
    } catch {
      if (mounted.current) Alert.alert(t("Something went wrong. Try again."));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <SettingsSwitch
      label={t("Haptic feedback")}
      value={enabled === true}
      disabled={enabled === undefined || saving}
      onChange={(value) => void change(value)}
    />
  );
}
