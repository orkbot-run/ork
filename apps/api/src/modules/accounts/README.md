<!-- SPDX-FileCopyrightText: 2026 Ork contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0 -->
<!-- Inherited documentation remains Apache-2.0; spending limit boundaries are PolyForm-covered. -->

# Accounts

Account import, export, deletion, access grants, identity confirmation, and onboarding live here. Organization membership routes belong here too. Auth primitives and email templates stay in `@orkbot/auth`.

Account spending limit routes derive the owner from the authenticated actor. They use the shared
database ledger and lock, and never accept a Space override or a user ID from the caller.

Import the named services from `account-*.ts`, `access-grants.ts`, `admins.ts`, `ai-consent.ts`, `identity-confirmation.ts`, or `onboarding.ts`. RPC factories are in `routes/account.ts` and `routes/organizations.ts`. These services receive storage and provider dependencies from the application.
