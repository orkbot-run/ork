<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->

<!-- Inherited Apache-2.0 module documentation is preserved. Accounts-only routing notes are Ork additions. -->

# Accounts

Account import, export, deletion, access grants, identity confirmation, and onboarding live here. Organization membership routes belong here too. Auth primitives and email templates stay in `@orkbot/auth`.

Import the named services from `account-*.ts`, `access-grants.ts`, `admins.ts`, `ai-consent.ts`, `identity-confirmation.ts`, `onboarding.ts`, or `first-ork.ts`. The `auth-callback.ts` route forwards the registered native loopback callback to the shared OIDC handler. Accounts-only startup expires sessions without central identity provenance through `accounts-only-sessions.ts`. RPC factories are in `routes/account.ts` and `routes/organizations.ts`. These services receive storage and provider dependencies from the application.
