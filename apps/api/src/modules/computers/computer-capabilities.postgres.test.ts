// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { randomUUID } from "node:crypto";
import { FakeSandboxProvider } from "@orkbot/adapters";
import type { Actor } from "@orkbot/contracts";
import {
  asSystem,
  bootstrapUserSpace,
  createDb,
  createRepos,
  createThreadEvents,
  runAsTenant,
} from "@orkbot/db";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import type { RouterDeps } from "#modules/platform/router";
import { createRouter } from "#modules/platform/router";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

it.skipIf(!databaseUrl)(
  "projects actual interfaces consistently through me, status, thread and bootstrap without starting a computer",
  async () => {
    const db = createDb(databaseUrl!);
    const system = asSystem(db.prisma);
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    try {
      await system.user.create({
        data: { id: userId, email, emailVerified: true, name: "Member" },
      });
      const { spaceId } = await bootstrapUserSpace(
        system,
        { id: userId },
        { signupsEnabled: "true", signupAllowlist: undefined },
      );
      const actor: Actor = { userId, email, spaceId, isDeploymentOwner: false };
      const bot = await runAsTenant(actor, () =>
        createRepos(db.prisma).createBot(actor, {
          name: "Headless",
          description: "",
          instructions: "",
          notifyOnFinish: true,
        }),
      );
      const stored = await system.bot.findUniqueOrThrow({ where: { id: bot.id } });
      const computer = await system.computer.update({
        where: { id: stored.computerId! },
        data: { state: "running", kind: "fake", providerRef: "active-reference" },
      });
      const sandbox = new FakeSandboxProvider();
      const descriptor = sandbox.describe();
      vi.spyOn(sandbox, "describe").mockReturnValue({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, graphical: false, takeover: false, pty: false },
      });
      const provision = vi.spyOn(sandbox, "provision");
      const connectScreen = vi.spyOn(sandbox, "connectScreen");
      const deps = {
        prisma: db.prisma,
        sandbox,
        secrets: { load: vi.fn(async () => "unused") },
        events: createThreadEvents(db.prisma),
        jobs: { enqueue: vi.fn(), cancel: vi.fn() },
        env: {
          defaultProvider: "fake",
          defaultModel: "fake-model",
          deploymentModelConfigured: true,
          sandboxProvider: "fake",
          agentRuntime: "scripted",
          adminEmails: [],
          webOrigin: "http://127.0.0.1:5173",
        },
      } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const expected = { start: true, screen: false, control: false, terminal: false };
      for (const procedure of ["me", "computer/status", "threads/get", "bootstrap"]) {
        const { response } = await handler.handle(
          new Request(`http://127.0.0.1/rpc/${procedure}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: procedure === "me" ? {} : { botId: bot.id } }),
          }),
          { prefix: "/rpc", context: { actor } },
        );
        expect(response?.status, procedure).toBe(200);
        const { json } = await response!.json();
        if (procedure === "me") expect(json.computerCapabilities).toEqual(expected);
        else if (procedure === "bootstrap") {
          expect(json.me.computerCapabilities).toEqual(expected);
          expect(json.thread.computer).toMatchObject({
            capabilities: expected,
            screenAvailable: false,
            terminalAvailable: false,
          });
        } else {
          expect(procedure === "computer/status" ? json : json.computer).toMatchObject({
            capabilities: expected,
            screenAvailable: false,
            terminalAvailable: false,
          });
        }
      }
      expect(provision).not.toHaveBeenCalled();
      expect(connectScreen).not.toHaveBeenCalled();
      expect(
        await system.computer.findUnique({
          where: { id: computer.id },
          select: { providerRef: true, state: true, controlHolder: true },
        }),
      ).toEqual({ providerRef: "active-reference", state: "running", controlHolder: "none" });
    } finally {
      await system.organization.deleteMany({ where: { members: { some: { userId } } } });
      await system.user.deleteMany({ where: { id: userId } });
      await db.prisma.$disconnect();
      await db.pool.end();
      vi.restoreAllMocks();
    }
  },
);
