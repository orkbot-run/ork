# Billing

This module applies billing plans and account access, handles billing callbacks, and manages referrals and marketing-email preferences. Payment-wallet routes delegate connection operations to workspace adapters, and billing provider calls use the injected billing interface.

Start with `createBillingService`. HTTP entrypoints are `mountBillingRoutes` and `marketingEmailRoutes`, with `paymentWalletRoutes` for RPC. `createReferrals`, `sendReferralEmails`, and `sendWelcomeEmail` handle referral and welcome flows.
