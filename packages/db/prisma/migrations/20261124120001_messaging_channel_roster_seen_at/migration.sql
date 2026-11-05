-- SPDX-FileCopyrightText: 2026 Rakazo contributors
-- SPDX-License-Identifier: Apache-2.0

-- The platform time of the newest roster a channel has processed; a delayed
-- older roster (a webhook retry) changes no membership.
ALTER TABLE "messaging_channels" ADD COLUMN "rosterSeenAt" TIMESTAMP(3);
