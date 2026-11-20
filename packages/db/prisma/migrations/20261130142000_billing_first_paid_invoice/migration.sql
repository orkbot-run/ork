-- SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
-- SPDX-FileCopyrightText: 2026 Ork contributors

ALTER TABLE "billing_accounts" ADD COLUMN "firstPaidInvoiceAt" TIMESTAMP(3);
