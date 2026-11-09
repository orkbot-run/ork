// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ActivityIndicator } from "react-native";
import { useMobileTokens } from "../lib/native";

export function ServerUpdateProgress({ label }: { label: string }) {
  const tokens = useMobileTokens();
  return <ActivityIndicator color={tokens.mutedForeground} accessibilityLabel={label} />;
}
