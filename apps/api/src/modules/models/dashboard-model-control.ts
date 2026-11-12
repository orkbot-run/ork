// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import {
  createWorkspaceModelGrantVerifier,
  oidcAccountSubject,
  workspaceConnectionStatus,
} from "@orkbot/auth";
import type { Actor } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { requireMembership, runAsSystem } from "@orkbot/db";

const actions = new Set(["list", "get", "set", "clear", "probe"]);

/** Only a request-bound proof from the connected Accounts service can reach the model controls. */
export function dashboardModelControl(options: {
  prisma: PrismaClient;
  issuer: string;
  origin: string;
  bootstrapSecret: string;
  keys?: Parameters<typeof createWorkspaceModelGrantVerifier>[0]["keys"];
  verifyGrant?: ReturnType<typeof createWorkspaceModelGrantVerifier>;
  connectionStatus?: () => Promise<"connected" | "unconnected" | "unknown">;
  dispatch: (
    actor: Actor,
    action: string,
    input: unknown,
    signal: AbortSignal,
    accountKey: string,
  ) => Promise<unknown>;
}) {
  const verify = options.verifyGrant ?? createWorkspaceModelGrantVerifier(options);
  return async (request: Request) => {
    const reply = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      });
    if (
      request.method !== "POST" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return reply({ error: "Invalid request" }, 400);
    let body: { action?: unknown; input?: unknown; grant?: unknown };
    try {
      body = await request.json();
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["action", "input", "grant"].includes(key)) ||
        typeof body.action !== "string" ||
        !actions.has(body.action) ||
        typeof body.grant !== "string" ||
        body.grant.length > 16384
      )
        throw new Error();
    } catch {
      return reply({ error: "Invalid request" }, 400);
    }
    try {
      const grant = await verify(body.grant as string, body.action as string, body.input);
      const actor = await runAsSystem("verify dashboard workspace model request", async () => {
        const settings = await options.prisma.deploymentSettings.findUnique({
          where: { id: "default" },
          select: {
            nativeAccountsOwnerKey: true,
            nativeAccountsOrganizationId: true,
            nativeAccountsWorkspaceClaimId: true,
          },
        });
        if (
          !settings?.nativeAccountsOwnerKey ||
          settings.nativeAccountsOrganizationId !== grant.organizationId ||
          settings.nativeAccountsWorkspaceClaimId !== grant.claimId ||
          (await (options.connectionStatus?.() ??
            workspaceConnectionStatus(options.prisma, options))) !== "connected"
        )
          return null;
        const account = await options.prisma.account.findFirst({
          where: { providerId: "oidc", accountId: settings.nativeAccountsOwnerKey },
          select: { userId: true },
        });
        if (!account) return null;
        const space = await options.prisma.space.findFirst({
          where: { createdByUserId: account.userId, isDefault: true, deletingAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        });
        if (!space) return null;
        const member = await requireMembership(options.prisma, account.userId, space.id);
        if (Math.random() < 1 / 64)
          await options.prisma.verification.deleteMany({
            where: {
              identifier: "dashboard-model-grant",
              expiresAt: { lt: new Date(Date.now() - 30_000) },
            },
          });
        // Uniqueness on id prevents replay across processes. Never persist request contents.
        await options.prisma.verification.create({
          data: {
            id: `dashboard-model-grant:${grant.id}`,
            identifier: "dashboard-model-grant",
            value: "used",
            expiresAt: new Date(grant.expiresAt * 1000),
          },
        });
        return member;
      });
      if (!actor) return reply({ error: "Workspace connection unavailable" }, 403);
      return reply({
        result: await options.dispatch(
          actor,
          body.action as string,
          body.input,
          request.signal,
          oidcAccountSubject(options.issuer, grant.subject),
        ),
      });
    } catch {
      // Provider errors can echo keys and request headers; do not return or log them.
      return reply({ error: "Could not complete workspace model request" }, 400);
    }
  };
}
