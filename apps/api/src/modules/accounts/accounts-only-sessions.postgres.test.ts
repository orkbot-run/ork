// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { createDb, runAsSystem } from "@orkbot/db";
import { expect, it } from "vitest";
import { expireNonOidcSessions } from "./accounts-only-sessions.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl || !process.env.COPY_TEST_DATABASE)(
  "expires a previously valid different owner session without changing users or accounts",
  async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const issuer = "https://identity.example.test";
    const suffix = randomUUID();
    const expectedOwnerKey = "ab".repeat(32);
    const owners = ["owner", "other"];
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    try {
      await runAsSystem("seed managed native owners", async () => {
        for (const name of owners) {
          const userId = `${name}-${suffix}`;
          await prisma.user.create({
            data: { id: userId, name, email: `${userId}@example.test`, emailVerified: true },
          });
          await prisma.account.create({
            data: {
              id: `account-${userId}`,
              userId,
              providerId: "oidc",
              accountId: name === "owner" ? expectedOwnerKey : "cd".repeat(32),
            },
          });
          await prisma.session.create({
            data: { id: `session-${userId}`, userId, token: `token-${userId}`, expiresAt },
          });
          await prisma.verification.create({
            data: {
              id: `proof-${userId}`,
              identifier: `oidc-session-v1-session-${userId}`,
              value: JSON.stringify([issuer, userId]),
              expiresAt,
            },
          });
          await prisma.userDevice.create({
            data: {
              id: `device-${userId}`,
              userId,
              name,
              platform: "macos",
              tokenHash: `hash-${userId}`,
              sessionId: `session-${userId}`,
            },
          });
        }
      });
      expect(await expireNonOidcSessions(prisma, issuer, expectedOwnerKey)).toEqual({
        expiredSessions: 1,
        revokedDevices: 1,
      });
      await runAsSystem("inspect preserved native ownership", async () => {
        const sessions = await prisma.session.findMany({
          where: { userId: { in: owners.map((name) => `${name}-${suffix}`) } },
        });
        for (const session of sessions)
          expect(session.expiresAt.getTime() > Date.now()).toBe(
            session.userId === `owner-${suffix}`,
          );
        expect(
          await prisma.user.count({
            where: { id: { in: owners.map((name) => `${name}-${suffix}`) } },
          }),
        ).toBe(2);
        expect(
          await prisma.account.count({
            where: { userId: { in: owners.map((name) => `${name}-${suffix}`) } },
          }),
        ).toBe(2);
      });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  },
);

// This startup policy scans the whole installation, so never run it in a shared database.
it.skipIf(!databaseUrl || !process.env.COPY_TEST_DATABASE)(
  "expires only unproven sessions and revokes their devices without deleting accounts",
  async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const issuer = "https://identity.example.test";
    const suffix = randomUUID();
    const userId = `accounts-only-"-${suffix}`;
    const cases = ["current", "password", "other-issuer", "other-user", "expired", "malformed"];
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const sessionId = (name: string) => `${name}-${suffix}`;
    try {
      await runAsSystem("seed identity-policy sessions", async () => {
        await prisma.user.create({
          data: {
            id: userId,
            name: "Test account",
            email: `${suffix}@example.test`,
            emailVerified: true,
          },
        });
        // Linking a central identity must not bless a previous password sign-in.
        await prisma.account.create({
          data: {
            id: `linked-${suffix}`,
            userId,
            providerId: "oidc",
            accountId: `subject-${suffix}`,
          },
        });
        await prisma.session.createMany({
          data: cases.map((name) => ({
            id: sessionId(name),
            userId,
            token: `token-${sessionId(name)}`,
            expiresAt,
          })),
        });
        await prisma.verification.createMany({
          data: cases
            .filter((name) => name !== "password")
            .map((name) => ({
              id: `proof-${sessionId(name)}`,
              identifier: `oidc-session-v1-${sessionId(name)}`,
              value:
                name === "malformed"
                  ? "not JSON"
                  : JSON.stringify([
                      name === "other-issuer" ? "https://other.example.test" : issuer,
                      name === "other-user" ? "another-user" : userId,
                    ]),
              expiresAt: name === "expired" ? new Date(0) : expiresAt,
            })),
        });
        await prisma.userDevice.createMany({
          data: [...cases, "unbound", "missing", "revoked"].map((name) => ({
            id: `device-${sessionId(name)}`,
            userId,
            name,
            platform: "macos",
            tokenHash: `hash-${sessionId(name)}`,
            sessionId: name === "unbound" ? null : sessionId(name),
            ...(name === "revoked" ? { revokedAt: new Date(0), revokedBy: "owner" } : {}),
          })),
        });
      });

      expect(await expireNonOidcSessions(prisma, issuer)).toEqual({
        expiredSessions: 5,
        revokedDevices: 7,
      });
      await runAsSystem("inspect identity-policy rollout", async () => {
        const sessions = await prisma.session.findMany({ where: { userId } });
        expect(sessions).toHaveLength(cases.length);
        for (const session of sessions)
          expect(session.expiresAt.getTime() > Date.now()).toBe(
            session.id === sessionId("current"),
          );
        const devices = await prisma.userDevice.findMany({ where: { userId } });
        for (const device of devices) {
          if (device.name === "current") expect(device.revokedAt).toBeNull();
          else if (device.name === "revoked") {
            expect(device.revokedAt).toEqual(new Date(0));
            expect(device.revokedBy).toBe("owner");
          } else {
            expect(device.revokedAt).not.toBeNull();
            expect(device.revokedBy).toBe("session");
          }
        }
        expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
        expect(await prisma.account.count({ where: { userId } })).toBe(1);
      });
      expect(await expireNonOidcSessions(prisma, issuer)).toEqual({
        expiredSessions: 0,
        revokedDevices: 0,
      });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  },
);
