// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("organization model setup migration", () => {
  it("keeps existing connections usable and asks empty installations for a choice", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE installation_identity (id text, "localOrganizationId" text) ON COMMIT DROP;
        CREATE TEMP TABLE server_ai_connections ("localOrganizationId" text) ON COMMIT DROP;
        CREATE TEMP TABLE central_workspace_bindings (id text, "localOrganizationId" text) ON COMMIT DROP;
        CREATE TEMP TABLE central_workspace_access ("workspaceId" text, "userId" text) ON COMMIT DROP;
        CREATE TEMP TABLE user_model_credentials ("userId" text) ON COMMIT DROP;
        INSERT INTO installation_identity VALUES ('empty', 'a'), ('shared', 'b'), ('personal', 'c');
        INSERT INTO server_ai_connections VALUES ('b');
        INSERT INTO central_workspace_bindings VALUES ('workspace', 'c');
        INSERT INTO central_workspace_access VALUES ('workspace', 'member');
        INSERT INTO user_model_credentials VALUES ('member');
      `);
      const migration = readFileSync(
        new URL(
          "../prisma/migrations/20261130130000_organization_model_setup/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(migration);
      const rows = await client.query(
        'SELECT id, "modelSetupMode" FROM installation_identity ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: "empty", modelSetupMode: "pending" },
        { id: "personal", modelSetupMode: "legacy" },
        { id: "shared", modelSetupMode: "legacy" },
      ]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
