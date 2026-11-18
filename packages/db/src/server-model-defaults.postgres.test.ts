// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.VERIFY_DATABASE !== "1")("server model default migration", () => {
  it("preserves differing Space settings and spending limits as explicit overrides", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE server_ai_connections (id text PRIMARY KEY, "localOrganizationId" text,
          "createdAt" timestamp, models jsonb) ON COMMIT DROP;
        CREATE TEMP TABLE spaces (id text PRIMARY KEY, "organizationId" text) ON COMMIT DROP;
        CREATE TEMP TABLE workspace_ai_connections ("spaceId" text, "connectionId" text,
          available boolean, enabled boolean, "allowedModels" jsonb, "defaultModelId" text,
          "isDefault" boolean, fallback boolean, priority int, "monthlyBudgetMicros" bigint) ON COMMIT DROP;
        CREATE TEMP TABLE ai_workspace_policies ("spaceId" text PRIMARY KEY, "monthlyBudgetMicros" bigint) ON COMMIT DROP;
        INSERT INTO server_ai_connections VALUES ('account', 'organization', now(), '["a", "b"]');
        INSERT INTO spaces VALUES ('space-a', 'organization'), ('space-b', 'organization'), ('space-c', 'organization');
        INSERT INTO workspace_ai_connections VALUES
          ('space-a', 'account', true, true, '["a"]', 'a', true, false, 0, 100),
          ('space-b', 'account', true, true, '["b"]', 'b', true, false, 0, 200),
          ('space-c', 'account', true, true, '["a"]', 'a', true, false, 0, 100);
        INSERT INTO ai_workspace_policies VALUES ('space-b', 300);
      `);
      const migration = readFileSync(
        new URL(
          "../prisma/migrations/20261130131000_server_model_defaults/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      // The data upgrade is isolated from trigger installation, which is exercised by catalog tests.
      await client.query(migration.slice(0, migration.indexOf("CREATE UNIQUE INDEX")));
      expect(
        (
          await client.query(
            'SELECT "isDefault", "defaultModelId", "defaultAllowedModels" FROM server_ai_connections',
          )
        ).rows,
      ).toEqual([{ isDefault: true, defaultModelId: "a", defaultAllowedModels: ["a"] }]);
      expect(
        (
          await client.query(
            'SELECT "spaceId", "monthlyBudgetMicros", "overridesModels" FROM ai_workspace_policies',
          )
        ).rows,
      ).toEqual([{ spaceId: "space-b", monthlyBudgetMicros: "300", overridesModels: true }]);
      expect(
        (
          await client.query(
            'SELECT "defaultModelId", "monthlyBudgetMicros" FROM workspace_ai_connections WHERE "spaceId" = $1',
            ["space-b"],
          )
        ).rows,
      ).toEqual([{ defaultModelId: "b", monthlyBudgetMicros: "200" }]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
