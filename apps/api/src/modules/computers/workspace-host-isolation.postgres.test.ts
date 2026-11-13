// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { UserDeviceSocket } from "@orkbot/adapters";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  UserDeviceHub,
  UserDevices,
  userDeviceForwardSecret,
} from "@orkbot/adapters";
import { InstallationClient } from "@orkbot/auth";
import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@orkbot/contracts";
import { asSystem, createDb } from "@orkbot/db";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { mountLocalComputerHost } from "./local-settings.js";

class PairedHost extends EventEmitter implements UserDeviceSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}
const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
it.skipIf(!databaseUrl)(
  "blocks an existing paired host as soon as the installation acquires a central binding",
  async () => {
    const db = createDb(databaseUrl!, { encryptContent: false });
    const prisma = asSystem(db.prisma);
    const userId = randomUUID();
    let hub: UserDeviceHub | undefined;
    try {
      await prisma.user.create({
        data: {
          id: userId,
          name: "Fixture owner",
          email: "workspace-host@example.test",
          emailVerified: true,
        },
      });
      const installation = new InstallationClient(db.prisma, {
        issuer: "https://accounts.example.test",
        encryptionKey: "fixture-private-material".repeat(3),
      });
      await installation.ensureIdentity();
      const allowHostAccess = async () => !(await installation.registered());
      const session = await prisma.session.create({
        data: {
          id: randomUUID(),
          token: randomUUID(),
          userId,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const token = createUserDeviceToken();
      const device = await prisma.userDevice.create({
        data: {
          userId,
          name: "Previously paired",
          platform: "linux",
          tokenHash: hashUserDeviceToken(token),
          sessionId: session.id,
        },
      });
      hub = new UserDeviceHub({
        prisma: db.prisma,
        address: "http://127.0.0.1:1",
        allowHostAccess,
      });
      const socket = new PairedHost();
      const connectionId = await hub.attach((await hub.authenticate(`Bearer ${token}`))!, socket);
      const gateway = new UserDevices({
        prisma: db.prisma,
        forwardSecret: userDeviceForwardSecret("fixture"),
        hub,
        allowHostAccess,
      });
      expect(await gateway.connected(userId)).not.toBeNull();
      await prisma.installationIdentity.update({
        where: { id: "local" },
        data: { state: "binding", serverId: randomUUID() },
      });
      expect(await gateway.connected(userId)).toBeNull();
      expect(await hub.authenticate(`Bearer ${token}`)).toBeNull();
      const frames = hub.frames(
        { deviceId: device.id, userId, connectionId },
        { method: "environment", botId: "workspace-home" },
        new AbortController().signal,
      );
      await expect(frames[Symbol.asyncIterator]().next()).rejects.toThrow();
      expect(socket.sent.some((entry) => JSON.parse(entry).type === "request")).toBe(false);
      const capability = "a".repeat(64);
      const app = new Hono();
      mountLocalComputerHost(app, {
        token: capability,
        sandboxProvider: "docker",
        prisma: db.prisma,
        hostAccessAllowed: allowHostAccess,
      });
      const select = (computerHost: string) =>
        app.request(LOCAL_COMPUTER_HOST_PATH, {
          method: "POST",
          headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: capability },
          body: JSON.stringify({ computerHost }),
        });
      expect((await select("this-mac")).status).toBe(403);
      expect((await select("docker")).status).toBe(200);
    } finally {
      await hub?.close();
      await prisma.installationIdentity.deleteMany({ where: { id: "local" } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  },
);
