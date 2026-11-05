-- SPDX-FileCopyrightText: 2026 Ork contributors
-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

-- Additive: previous releases keep using purchases without reading these tables.
CREATE TABLE "account_spending_limits" (
    "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "amount" DECIMAL(18,2) NOT NULL CHECK ("amount" >= 0),
    "currency" TEXT NOT NULL CHECK ("currency" IN ('USD', 'EUR', 'GBP', 'ILS', 'PLN')),
    "period" TEXT NOT NULL CHECK ("period" IN ('daily', 'weekly', 'monthly', 'never')),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "payment_ledger_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "operationKey" TEXT NOT NULL,
    "pageOperationKey" TEXT,
    "amount" DECIMAL(18,2) CHECK ("amount" >= 0),
    "currency" TEXT,
    "status" TEXT NOT NULL CHECK ("status" IN ('reserved', 'confirmed', 'released')),
    "countedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payment_ledger_entries_money_pair" CHECK (("amount" IS NULL) = ("currency" IS NULL))
);

CREATE UNIQUE INDEX "payment_ledger_entries_userId_operationKey_key"
    ON "payment_ledger_entries"("userId", "operationKey");
CREATE INDEX "payment_ledger_entries_userId_currency_status_countedAt_idx"
    ON "payment_ledger_entries"("userId", "currency", "status", "countedAt");

-- Wallet amounts use minor units. Preserve existing approvals and completed payments.
INSERT INTO "payment_ledger_entries"
    ("id", "userId", "operationKey", "amount", "currency", "status", "countedAt", "createdAt", "updatedAt")
SELECT 'wallet:' || p."id", p."userId", 'wallet:' || p."operationKey",
    p."amount"::numeric / 100, upper(p."currency"),
    CASE WHEN p."status" = 'completed' THEN 'confirmed' ELSE 'reserved' END,
    p."createdAt", p."createdAt", p."updatedAt"
FROM "purchases" p
JOIN "user" u ON u."id" = p."userId"
WHERE p."status" IN ('pending_approval', 'needs_action', 'approved', 'completed');

-- Older releases stopped polling after approval or after a bot detached from its chat.
-- Reconcile every backfilled open purchase so known failures and expiry release its hold.
UPDATE "purchases"
SET "nextPollAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('pending_approval', 'needs_action', 'approved') AND "nextPollAt" IS NULL;

ALTER TABLE "account_spending_limits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_spending_limits_tenant ON "account_spending_limits"
    USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY account_spending_limits_system ON "account_spending_limits"
    USING ((SELECT app_rls_bypass()));

ALTER TABLE "payment_ledger_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_ledger_entries_tenant ON "payment_ledger_entries"
    USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY payment_ledger_entries_system ON "payment_ledger_entries"
    USING ((SELECT app_rls_bypass()));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON "account_spending_limits", "payment_ledger_entries" TO rakazo_app;
    END IF;
END $$;
