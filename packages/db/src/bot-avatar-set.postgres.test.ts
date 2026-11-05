// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache-2.0 migration tests are preserved. Ork default coverage is a PolyForm-covered addition.

import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("avatar-set migration and persistence (PostgreSQL)", () => {
  it("updates existing defaults and new-row defaults without replacing pinned sets or custom values", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Temporary tables shadow both real tables, including their old defaults.
      await client.query(`CREATE TEMP TABLE "user" (
        id TEXT PRIMARY KEY, "botAvatarSet" TEXT NOT NULL DEFAULT 'organic'
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE bots (
        id TEXT PRIMARY KEY, color TEXT NOT NULL,
        "avatarSet" TEXT NOT NULL DEFAULT 'organic',
        "avatarSetPinned" BOOLEAN NOT NULL DEFAULT false
      ) ON COMMIT DROP`);
      for (const avatarSet of ["organic", "orkbot", "rakazo"])
        await client.query('INSERT INTO "user" (id, "botAvatarSet") VALUES ($1, $2)', [
          avatarSet,
          avatarSet,
        ]);
      const avatars = ["#8B5CF6", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="];
      for (const [index, color] of avatars.entries()) {
        await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", [
          `default-${index}`,
          color,
        ]);
        await client.query(
          'INSERT INTO bots (id, color, "avatarSetPinned") VALUES ($1, $2, true)',
          [`pinned-${index}`, color],
        );
      }
      for (const avatarSet of ["orkbot", "rakazo"])
        await client.query('INSERT INTO bots (id, color, "avatarSet") VALUES ($1, $2, $1)', [
          avatarSet,
          "#123456",
        ]);
      const before = (await client.query("SELECT * FROM bots ORDER BY id")).rows;
      const migration = await readFile(
        new URL(
          "../prisma/migrations/20261127130000_orkbot_avatar_default/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await client.query(migration);
      const expectedSets = [
        "orkbot",
        "orkbot",
        "orkbot",
        "orkbot",
        "organic",
        "organic",
        "organic",
        "rakazo",
      ];
      expect((await client.query("SELECT * FROM bots ORDER BY id")).rows).toEqual(
        before.map((bot, index) => ({
          ...bot,
          avatarSet: expectedSets[index],
        })),
      );
      expect((await client.query('SELECT * FROM "user" ORDER BY id')).rows).toEqual([
        { id: "organic", botAvatarSet: "orkbot" },
        { id: "orkbot", botAvatarSet: "orkbot" },
        { id: "rakazo", botAvatarSet: "rakazo" },
      ]);
      await client.query('INSERT INTO "user" (id) VALUES ($1)', ["new-owner"]);
      await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", ["new-bot", "#abcdef"]);
      expect(
        (await client.query('SELECT "botAvatarSet" FROM "user" WHERE id=$1', ["new-owner"])).rows[0]
          .botAvatarSet,
      ).toBe("orkbot");
      expect(
        (await client.query('SELECT "avatarSet", color FROM bots WHERE id=$1', ["new-bot"]))
          .rows[0],
      ).toEqual({ avatarSet: "orkbot", color: "#abcdef" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
  it("preserves legacy rows and defaults new bots to Original, with explicit switch/reload", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A temporary table shadows public.bots; this test never alters real bot rows.
      await client.query(
        "CREATE TEMP TABLE bots (id TEXT PRIMARY KEY, color TEXT NOT NULL) ON COMMIT DROP",
      );
      const colors = ["#8B5CF6", "#8B5CF6::shape_3", "data:image/png;base64,aGVsbG8="];
      for (const [index, color] of colors.entries())
        await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", [`old-${index}`, color]);
      for (const migration of [
        "20261030120000_bot_avatar_set",
        "20261031120000_bot_avatar_set_original_default",
      ])
        await client.query(
          await readFile(
            new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
            "utf8",
          ),
        );
      expect(
        (await client.query('SELECT id, color, "avatarSet" FROM bots ORDER BY id')).rows,
      ).toEqual(
        colors.map((color, index) => ({ id: `old-${index}`, color, avatarSet: "organic" })),
      );
      await client.query("INSERT INTO bots (id, color) VALUES ($1, $2)", ["new", "#3B82F6"]);
      expect(
        (await client.query('SELECT "avatarSet" FROM bots WHERE id=$1', ["new"])).rows[0].avatarSet,
      ).toBe("organic");
      await client.query('INSERT INTO bots (id, color, "avatarSet") VALUES ($1, $2, $3)', [
        "explicit",
        "#3B82F6",
        "organic",
      ]);
      await client.query('UPDATE bots SET "avatarSet"=$1 WHERE id=$2', ["orkbot", "old-0"]);
      expect(
        (await client.query('SELECT "avatarSet", color FROM bots WHERE id=$1', ["old-0"])).rows[0],
      ).toEqual({ avatarSet: "orkbot", color: colors[0] });
      expect(
        (await client.query('SELECT "avatarSet" FROM bots WHERE id=$1', ["explicit"])).rows[0]
          .avatarSet,
      ).toBe("organic");
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
