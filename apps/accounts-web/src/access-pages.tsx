// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useState } from "react";
import { ACCOUNT_PATH, accountLink, auth, authError, authorizationExpired } from "./auth";
import { AccountForm, emailField, newPasswordField } from "./form";

const linkStyle = "text-sm underline underline-offset-4";

export function SignIn() {
  const [expired, setExpired] = useState(() => authorizationExpired(location.search));
  if (expired)
    return (
      <div className="space-y-4">
        <p role="alert">This sign-in request is invalid or expired.</p>
        <a className={linkStyle} href="/sign-in">
          Start again
        </a>
      </div>
    );
  const error = new URLSearchParams(location.search).get("error");
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          This link is invalid or has expired. Request a new email.
        </p>
      )}
      {new URLSearchParams(location.search).get("verified") && (
        <p role="status">Email verified. You can sign in.</p>
      )}
      <AccountForm
        title="Sign in"
        action="Sign in"
        fields={[
          emailField,
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "current-password",
            maxLength: 128,
          },
        ]}
        submit={async ({ email, password }) => {
          if (authorizationExpired(location.search)) {
            setExpired(true);
            return null;
          }
          const result = await auth.signIn.email({
            email: email!,
            password: password!,
            callbackURL: ACCOUNT_PATH,
          });
          if (
            result.error &&
            "error" in result.error &&
            result.error.error === "invalid_signature"
          ) {
            setExpired(true);
            return null;
          }
          return authError(result.error);
        }}
      >
        <nav className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Account help">
          <a className={linkStyle} href={accountLink("/sign-up")}>
            Create account
          </a>
          <a className={linkStyle} href={accountLink("/forgot-password")}>
            Forgot password?
          </a>
          <a className={linkStyle} href={accountLink("/verify-email")}>
            Resend verification
          </a>
        </nav>
      </AccountForm>
    </>
  );
}

export function SignUp() {
  const [sent, setSent] = useState(false);
  if (sent) return <EmailSent />;
  return (
    <AccountForm
      title="Create account"
      action="Create account"
      fields={[
        { name: "name", label: "Name", autoComplete: "name", maxLength: 100 },
        emailField,
        newPasswordField,
      ]}
      submit={async ({ name, email, password }) => {
        const callback = new URL(accountLink("/sign-in"), location.origin);
        callback.searchParams.set("verified", "1");
        const result = await auth.signUp.email({
          name: name!,
          email: email!,
          password: password!,
          callbackURL: callback.href,
        });
        if (result.error) return authError(result.error);
        setSent(true);
        return null;
      }}
    >
      <SignInLink />
    </AccountForm>
  );
}

function SignInLink() {
  return (
    <a className={linkStyle} href={accountLink("/sign-in")}>
      Back to sign in
    </a>
  );
}

function EmailSent() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Check your email</h2>
      <p role="status" className="text-sm text-muted-foreground">
        If your account needs this email, a link is on its way. Check your spam folder too.
      </p>
      <SignInLink />
    </div>
  );
}

export function RequestEmail({ verification = false }: { verification?: boolean }) {
  const [sent, setSent] = useState(false);
  if (sent) return <EmailSent />;
  return (
    <AccountForm
      title={verification ? "Verify your email" : "Reset password"}
      action="Send link"
      fields={[emailField]}
      submit={async ({ email }) => {
        const callback = new URL(accountLink("/sign-in"), location.origin);
        callback.searchParams.set("verified", "1");
        const result = verification
          ? await auth.sendVerificationEmail({ email: email!, callbackURL: callback.href })
          : await auth.requestPasswordReset({
              email: email!,
              redirectTo: new URL(accountLink("/reset-password"), location.origin).href,
            });
        if (result.error) return authError(result.error);
        setSent(true);
        return null;
      }}
    >
      <SignInLink />
    </AccountForm>
  );
}

export function ResetPassword() {
  const query = new URLSearchParams(location.search);
  const [done, setDone] = useState(false);
  if (done)
    return (
      <div className="space-y-4">
        <p role="status">Password updated. Sign in with your new password.</p>
        <SignInLink />
      </div>
    );
  if (!query.get("token") || query.has("error"))
    return (
      <div className="space-y-4">
        <p role="alert">This reset link is invalid or has expired.</p>
        <a className={linkStyle} href={accountLink("/forgot-password")}>
          Request a new link
        </a>
      </div>
    );
  return (
    <AccountForm
      title="Choose a new password"
      action="Update password"
      fields={[newPasswordField]}
      submit={async ({ password }) => {
        const result = await auth.resetPassword({
          newPassword: password!,
          token: query.get("token")!,
        });
        if (result.error) return authError(result.error);
        // Remove the spent secret from the current history entry.
        history.replaceState(null, "", accountLink("/reset-password"));
        setDone(true);
        return null;
      }}
    />
  );
}
