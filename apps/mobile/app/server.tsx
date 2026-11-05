// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 server selection is preserved through the shared client settings.
// Central account directory navigation is an Ork addition.

import { Stack, useRouter } from "expo-router";
import { AccountsGate } from "../components/accounts-gate";
import { useI18n } from "../lib/i18n";

export default function ServerScreen() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <>
      <Stack.Screen options={{ title: t("Server") }} />
      <AccountsGate onSelected={() => router.replace("/sign-in")} />
    </>
  );
}
