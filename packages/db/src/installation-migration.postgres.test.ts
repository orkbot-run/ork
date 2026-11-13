// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { deployMigrations } from "./deferred-migrations.js";

const ownerUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && ownerUrl && runtimeUrl;
const dbPackageDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = path.join(dbPackageDir, "prisma/migrations");
const firstIdentityMigration = "20261130120000_installation_identity";

async function snapshot(client: Client) {
  const tables = [
    "user",
    "organization",
    "member",
    "spaces",
    "space_members",
    "secrets",
    "workspace_model_policy",
    "deployment_settings",
  ];
  const rows: Array<[string, unknown]> = [];
  for (const table of tables) {
    const result = await client.query(
      `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
    );
    rows.push([table, result.rows]);
  }
  return Object.fromEntries(rows);
}

describe.skipIf(!enabled)("installation identity schema upgrade (PostgreSQL)", () => {
  it("preserves existing local ownership and credentials while the new authority survives compatible recovery", async () => {
    const ownerConnection = new URL(ownerUrl!);
    const runtimeConnection = new URL(runtimeUrl!);
    if (
      !["127.0.0.1", "localhost"].includes(ownerConnection.hostname) ||
      ownerConnection.host !== runtimeConnection.host ||
      ownerConnection.username === runtimeConnection.username
    )
      throw new Error("Use isolated loopback databases with separate owner/runtime roles");
    const name = `installation_upgrade_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: ownerUrl });
    ownerConnection.pathname = runtimeConnection.pathname = `/${name}`;
    const owner = new Client({ connectionString: ownerConnection.href });
    const runtime = new Client({ connectionString: runtimeConnection.href });
    const legacyDir = mkdtempSync(path.join(tmpdir(), "installation-legacy-migrations-"));
    let created = false;
    let runtimeConnected = false;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      await owner.connect();
      for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name < firstIdentityMigration)
          cpSync(path.join(migrationsDir, entry.name), path.join(legacyDir, entry.name), {
            recursive: true,
          });
      }
      // Use the production migration runner and historical SQL, not a current schema with columns removed.
      await deployMigrations({
        migrationUrl: ownerConnection.href,
        dbPackageDir,
        migrationsDir: legacyDir,
      });
      expect(
        (await owner.query("SELECT to_regclass('installation_identity') AS relation")).rows[0],
      ).toEqual({ relation: null });
      await owner.query(
        "INSERT INTO \"user\" (id, name, email, \"updatedAt\") VALUES ('migration-owner', 'Owner', 'owner@example.test', now())",
      );
      for (const organization of ["existing-a", "existing-b"]) {
        await owner.query(
          "INSERT INTO organization (id, name, slug, \"createdAt\") VALUES ($1, 'Same display name', $1, now())",
          [organization],
        );
        await owner.query(
          'INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, \'migration-owner\', \'owner\', now())',
          [`${organization}-member`, organization],
        );
      }
      for (const [space, organization] of [
        ["space-a", "existing-a"],
        ["space-b", "existing-a"],
        ["space-c", "existing-b"],
      ]) {
        await owner.query(
          'INSERT INTO spaces (id, "organizationId", name, "createdByUserId") VALUES ($1, $2, $1, \'migration-owner\')',
          [space, organization],
        );
        await owner.query(
          'INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, \'migration-owner\', \'admin\', now())',
          [`${space}-membership`, space, organization],
        );
      }
      await owner.query(
        "INSERT INTO secrets (id, \"userId\", \"spaceId\", kind, ciphertext) VALUES ('retained-model-secret', 'migration-owner', NULL, 'model', 'fictional-opaque-ciphertext'), ('retained-space-secret', 'migration-owner', 'space-a', 'agent', 'fictional-space-ciphertext')",
      );
      await owner.query(
        "INSERT INTO workspace_model_policy (\"organizationId\", provider, \"modelId\", \"secretId\", \"secretRef\", \"updatedAt\") VALUES ('existing-a', 'fixture-provider', 'fixture-model', 'retained-model-secret', 'fictional-opaque-reference', now())",
      );
      await owner.query(
        "INSERT INTO deployment_settings (id, \"ownerUserId\", \"nativeAccountsOwnerKey\", \"nativeAccountsOrganizationId\", \"nativeAccountsWorkspaceClaimId\", \"nativeAccountsWorkspaceReceipt\", \"deploymentModelCredentialCipher\", \"updatedAt\") VALUES ('default', 'migration-owner', 'fictional-owner-proof', 'retained-central-organization', 'retained-claim', 'fictional-receipt-ciphertext', 'fictional-deployment-ciphertext', now())",
      );
      const before = await snapshot(owner);
      const oldJournal = (
        await owner.query(
          'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name',
        )
      ).rows;
      await deployMigrations({ migrationUrl: ownerConnection.href, dbPackageDir });
      expect(await snapshot(owner)).toEqual(before);
      expect(
        (
          await owner.query(
            'SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND migration_name < $1 ORDER BY migration_name',
            [firstIdentityMigration],
          )
        ).rows,
      ).toEqual(oldJournal);
      expect((await owner.query("SELECT * FROM installation_identity")).rows).toEqual([]);
      expect((await owner.query("SELECT * FROM central_workspace_bindings")).rows).toEqual([]);
      expect(
        (
          await owner.query(
            'SELECT id, "localOrganizationId", "secretId", "secretRef" FROM server_ai_connections',
          )
        ).rows,
      ).toEqual([
        {
          id: "legacy:existing-a",
          localOrganizationId: "existing-a",
          secretId: "retained-model-secret",
          secretRef: "fictional-opaque-reference",
        },
      ]);
      expect(
        (
          await owner.query(
            'SELECT "spaceId", "connectionId", "bindingVersion" FROM workspace_ai_connections ORDER BY "spaceId"',
          )
        ).rows,
      ).toEqual([
        { spaceId: "space-a", connectionId: "legacy:existing-a", bindingVersion: 0 },
        { spaceId: "space-b", connectionId: "legacy:existing-a", bindingVersion: 0 },
      ]);

      // An operator chooses this exact existing organization and Space; migration never guesses it.
      await owner.query(
        "INSERT INTO central_workspace_bindings (id, \"serverId\", \"centralOrganizationId\", \"localOrganizationId\", \"spaceId\", \"operationId\", \"bindingVersion\", \"permissionVersion\", state, members, \"verifiedAt\", \"validUntil\") VALUES ('central-workspace', 'central-server', 'central-organization', 'existing-a', 'space-a', 'fixture-operation', 1, 1, 'ready', '[]', now(), now() + interval '5 minutes')",
      );
      await owner.query(
        "INSERT INTO central_workspace_access (\"workspaceId\", \"userId\", \"centralSubject\", \"membershipVersion\", role, active) VALUES ('central-workspace', 'migration-owner', 'central-owner', 'membership-one', 'admin', true)",
      );
      await runtime.connect();
      runtimeConnected = true;
      await runtime.query(
        "SELECT set_config('app.space_id', 'space-a', false), set_config('app.user_id', 'migration-owner', false)",
      );
      expect((await runtime.query("SELECT count(*)::int AS count FROM secrets")).rows[0]).toEqual({
        count: 1,
      });
      await owner.query(
        "UPDATE central_workspace_access SET active = false WHERE \"workspaceId\" = 'central-workspace'",
      );
      expect((await runtime.query("SELECT count(*)::int AS count FROM secrets")).rows[0]).toEqual({
        count: 0,
      });
      const authority = (await owner.query("SELECT * FROM central_workspace_bindings")).rows;
      const assignments = (await owner.query("SELECT * FROM central_workspace_access")).rows;
      await runtime.end();
      runtimeConnected = false;

      // Compatible runtime recovery retains schema and revoked admission, never a down migration.
      await deployMigrations({ migrationUrl: ownerConnection.href, dbPackageDir });
      const replacement = new Client({ connectionString: runtimeConnection.href });
      await replacement.connect();
      try {
        await replacement.query(
          "SELECT set_config('app.space_id', 'space-a', false), set_config('app.user_id', 'migration-owner', false)",
        );
        expect(
          (await replacement.query("SELECT count(*)::int AS count FROM secrets")).rows[0],
        ).toEqual({ count: 0 });
        expect((await owner.query("SELECT * FROM central_workspace_bindings")).rows).toEqual(
          authority,
        );
        expect((await owner.query("SELECT * FROM central_workspace_access")).rows).toEqual(
          assignments,
        );
        expect(await snapshot(owner)).toEqual(before);
        await expect(
          replacement.query("DROP TABLE central_workspace_bindings"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await replacement.end();
      }
    } finally {
      if (runtimeConnected) await runtime.end();
      await owner.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  }, 90_000);
});
