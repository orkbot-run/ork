// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RequestEmail, ResetPassword, SignIn, SignUp } from "./access-pages";
import { Account } from "./account";
import { ACCOUNT_PATH, auth } from "./auth";
import "./styles.css";

function Accounts() {
  const { data: session, isPending, error } = auth.useSession();
  const path = location.pathname.slice(ACCOUNT_PATH.length) || "/";
  const isAuthorization = new URLSearchParams(location.search).has("client_id");
  let content: ReactNode;
  // Recovery and registration forms keep their state while the session query refetches.
  if (path === "/reset-password") content = <ResetPassword />;
  else if (path === "/sign-up") content = <SignUp />;
  else if (path === "/forgot-password") content = <RequestEmail />;
  else if (path === "/verify-email") content = <RequestEmail verification />;
  else if (isPending && !session) content = <p role="status">Loading…</p>;
  else if (error)
    content = <p role="alert">Unable to load your account. Please reload the page.</p>;
  else if (session && !isAuthorization) content = <Account email={session.user.email} />;
  else content = <SignIn />;
  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">Ork Account</h1>
        {content}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Accounts />);
