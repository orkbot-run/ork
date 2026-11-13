// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { provisionNativeIdentity, withVerifiedNativeLogin } from "./native-accounts-login.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const challengeKey = (value: string) => `workspace-login-challenge-v2:${hash(value)}`;
const denied = () =>
  new APIError("FORBIDDEN", { code: "NATIVE_LOGIN_REFUSED", message: "Could not continue" });

/** Accounts bearer tokens never enter this endpoint; only a signed, single-use workspace grant does. */
export function nativeWorkspaceLogin(
  prisma: PrismaClient,
  authority: WorkspaceAuthority,
): BetterAuthPlugin {
  return {
    id: "native-workspace-login-v2",
    endpoints: {
      workspaceLoginChallenge: createAuthEndpoint(
        "/native/workspace/challenge",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const challenge = randomBytes(32).toString("base64url");
          const expiresAt = Math.floor(Date.now() / 1000) + 120;
          await runAsSystem("issue a single-use workspace login challenge", () =>
            prisma.verification.create({
              data: {
                id: challengeKey(challenge),
                identifier: challengeKey(challenge),
                value: "workspace-v2",
                expiresAt: new Date(expiresAt * 1000),
              },
            }),
          );
          return ctx.json({ version: 2, challenge, expiresAt });
        },
      ),
      workspaceLoginComplete: createAuthEndpoint(
        "/native/workspace/complete",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const body = ctx.body as
            | { challenge?: unknown; grant?: unknown; deviceSignature?: unknown }
            | undefined;
          if (
            !body ||
            typeof body.challenge !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(body.challenge) ||
            typeof body.grant !== "string" ||
            body.grant.length > 16 * 1024
          )
            throw denied();
          try {
            const identity = await authority.login(
              body.grant,
              body.challenge,
              body.deviceSignature,
            );
            await runAsSystem("consume a workspace login challenge and prevent grant replay", () =>
              prisma.$transaction(async (tx) => {
                const consumed = await tx.verification.deleteMany({
                  where: {
                    id: challengeKey(body.challenge as string),
                    value: "workspace-v2",
                    expiresAt: { gt: new Date() },
                  },
                });
                if (consumed.count !== 1) throw denied();
                const replay = `workspace-login-grant-v2:${hash(JSON.stringify([identity.issuer, identity.jwtId]))}`;
                await tx.verification.create({
                  data: {
                    id: replay,
                    identifier: replay,
                    value: "used",
                    expiresAt: new Date(identity.expiresAt * 1000),
                  },
                });
              }),
            );
            return await withVerifiedNativeLogin(identity, async () => {
              const user = await provisionNativeIdentity(ctx, identity, body.grant as string);
              await authority.provisionMember(user.id, identity);
              const session = await ctx.context.internalAdapter.createSession(user.id);
              if (!session) throw denied();
              try {
                await authority.bindSession(session.id, user.id, identity);
                if (identity.personalDevice)
                  await authority.personal.activate(
                    session.id,
                    user.id,
                    identity,
                    identity.personalDevice,
                  );
              } catch (error) {
                await ctx.context.internalAdapter.deleteSession(session.token);
                throw error;
              }
              await setSessionCookie(ctx, { session, user });
              return ctx.json({
                token: session.token,
                user: { id: user.id },
                workspaceId: identity.centralWorkspace!.id,
                spaceId: identity.centralWorkspace!.spaceId,
                ...(identity.personalDevice
                  ? {
                      personalDevice: {
                        id: identity.personalDevice.id,
                        target: await authority.personal.target(
                          (await authority.personal.device(identity.personalDevice.id))!,
                        ),
                      },
                    }
                  : {}),
              });
            });
          } catch {
            throw denied();
          }
        },
      ),
    },
  };
}
