// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Redirect } from "expo-router";

/** The native auth session consumes the callback; product routing resumes after the Accounts gate. */
export default function AccountsCallback() {
  return <Redirect href="/sign-in" />;
}
