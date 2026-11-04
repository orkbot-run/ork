# Accounts

Account import, export, deletion, access grants, identity confirmation, and onboarding live here. Organization membership routes belong here too. Auth primitives and email templates stay in `@orkbot/auth`.

Import the named services from `account-*.ts`, `access-grants.ts`, `admins.ts`, `ai-consent.ts`, `identity-confirmation.ts`, or `onboarding.ts`. RPC factories are in `routes/account.ts` and `routes/organizations.ts`. These services receive storage and provider dependencies from the application.
