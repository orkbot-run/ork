// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Button } from "@orkbot/ui-web/components/ui/button";
import { useState } from "react";
import { ACCOUNT_PATH, auth, authError } from "./auth";
import { AccountForm, newPasswordField } from "./form";

export function Account({ email }: { email: string }) {
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signOut(everywhere: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (everywhere) {
        const result = await auth.revokeSessions();
        if (result.error) {
          setError(authError(result.error));
          return;
        }
      }
      const result = await auth.signOut();
      if (result.error) setError(authError(result.error));
      else location.assign(`${ACCOUNT_PATH}/sign-in`);
    } catch {
      setError("Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <p>{email}</p>
      <a href="/" className="text-sm underline underline-offset-4">
        Open dashboard
      </a>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {changing ? (
        <AccountForm
          title="Change password"
          action="Update password"
          fields={[
            {
              name: "currentPassword",
              label: "Current password",
              type: "password",
              autoComplete: "current-password",
              maxLength: 128,
            },
            newPasswordField,
          ]}
          submit={async ({ currentPassword, password }) => {
            const result = await auth.changePassword({
              currentPassword: currentPassword!,
              newPassword: password!,
              revokeOtherSessions: true,
            });
            if (result.error) return authError(result.error);
            setChanging(false);
            setMessage("Password updated. Other account sessions have been signed out.");
            return null;
          }}
        >
          <Button type="button" variant="ghost" onClick={() => setChanging(false)}>
            Cancel
          </Button>
        </AccountForm>
      ) : (
        <Button variant="outline" onClick={() => setChanging(true)}>
          Change password
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => signOut(false)}>
          Sign out
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => signOut(true)}>
          Sign out all account sessions
        </Button>
      </div>
    </div>
  );
}
