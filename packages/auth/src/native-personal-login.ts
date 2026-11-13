// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash, randomBytes } from "node:crypto";
import { personalOfflineMessage } from "@orkbot/contracts";
import type { PrismaClient } from "@orkbot/db";
import { runAsSystem } from "@orkbot/db";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { withVerifiedNativeLogin } from "./native-accounts-login.js";
import { personalDeviceSignature } from "./personal-device-key.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";

const key = (nonce: string) =>
  `personal-device-login-v1:${createHash("sha256").update(nonce).digest("hex")}`;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const denied = () =>
  new APIError("FORBIDDEN", { code: "NATIVE_LOGIN_REFUSED", message: "Could not continue" });

/** Offline renewal requires a previously activated key, never an expired Accounts bearer. */
export function nativePersonalLogin(
  prisma: PrismaClient,
  authority: WorkspaceAuthority,
): BetterAuthPlugin {
  return {
    id: "native-personal-login-v1",
    endpoints: {
      personalLoginChallenge: createAuthEndpoint(
        "/native/workspace/personal/challenge",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const body = ctx.body as { deviceId?: unknown } | undefined;
          if (!uuid(body?.deviceId)) throw denied();
          try {
            const challenge = randomBytes(32).toString("base64url");
            const proof = await authority.personalChallenge(body.deviceId, challenge);
            const expiresAt = Math.floor(Date.now() / 1000) + 120;
            await runAsSystem("issue a single-use personal device login challenge", () =>
              prisma.verification.create({
                data: {
                  id: key(challenge),
                  identifier: key(challenge),
                  value: body.deviceId as string,
                  expiresAt: new Date(expiresAt * 1000),
                },
              }),
            );
            return ctx.json({ version: 1, challenge, expiresAt, ...proof });
          } catch {
            throw denied();
          }
        },
      ),
      personalLoginComplete: createAuthEndpoint(
        "/native/workspace/personal/complete",
        { method: "POST" },
        async (ctx) => {
          ctx.setHeader("Cache-Control", "no-store");
          const body = ctx.body as
            | { deviceId?: unknown; challenge?: unknown; signature?: unknown }
            | undefined;
          if (
            !uuid(body?.deviceId) ||
            typeof body?.challenge !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(body.challenge)
          )
            throw denied();
          try {
            const device = await authority.personal.device(body.deviceId);
            if (
              !device ||
              !personalDeviceSignature(
                device.publicKey,
                personalOfflineMessage(await authority.personal.target(device), body.challenge),
                body.signature,
              )
            )
              throw denied();
            const consumed = await runAsSystem(
              "consume a personal device challenge before creating a session",
              () =>
                prisma.verification.deleteMany({
                  where: {
                    id: key(body.challenge as string),
                    value: device.id,
                    expiresAt: { gt: new Date() },
                  },
                }),
            );
            if (consumed.count !== 1) throw denied();
            const restored = await authority.personalIdentity(device.id);
            if (!restored) throw denied();
            return await withVerifiedNativeLogin(restored.identity, async () => {
              const user = await ctx.context.internalAdapter.findUserById(restored.userId);
              if (!user?.emailVerified) throw denied();
              const session = await ctx.context.internalAdapter.createSession(user.id);
              if (!session) throw denied();
              try {
                await authority.bindSession(session.id, user.id, restored.identity);
              } catch (error) {
                await ctx.context.internalAdapter.deleteSession(session.token);
                throw error;
              }
              await setSessionCookie(ctx, { session, user });
              return ctx.json({
                token: session.token,
                user: { id: user.id },
                workspaceId: device.workspaceId,
                spaceId: restored.identity.centralWorkspace!.spaceId,
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
