// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { z } from "zod";
import { isLoopbackHost } from "./network-host.js";

export const IDENTITY_PROTOCOL = 2;
export const IDENTITY_LOGIN_PURPOSE = "ork-server-login-v2";
export const IDENTITY_ACCESS_PURPOSE = "ork-workspace-access-v2";
export const IDENTITY_ENROLLMENT_PURPOSE = "ork-server-enrollment-v2";
export const IDENTITY_PROJECTION_PURPOSE = "ork-workspace-projection-v2";
export const IDENTITY_LOGIN_SECONDS = 60;
export const IDENTITY_ACCESS_SECONDS = 300;
export const identityAudience = (serverId: string) => `urn:ork:server:${serverId}`;
const id = z.uuid();
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const workspaceAccessRoleSchema = z.enum(["admin", "member"]);

export const workspaceProjectionSchema = z
  .object({
    serverId: id,
    organizationId: id,
    bindingVersion: positive,
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: positive,
    expiresAt: positive,
    workspaces: z
      .array(
        z
          .object({
            id,
            name: z.string().min(1).max(100),
            operationId: id,
            state: z.enum(["provisioning", "ready", "failed", "disabled"]),
            localOrganizationId: z.string().min(1).max(200).nullable(),
            localWorkspaceId: z.string().min(1).max(200).nullable(),
            permissionVersion: positive,
            members: z
              .array(
                z
                  .object({
                    userId: z.string().min(1).max(200),
                    role: workspaceAccessRoleSchema,
                    accessVersion: id,
                  })
                  .strict(),
              )
              .max(100_000),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt > value.verifiedAt &&
      value.expiresAt - value.verifiedAt <= IDENTITY_ACCESS_SECONDS,
    { message: "Invalid authorization lifetime" },
  );
export type WorkspaceProjection = z.infer<typeof workspaceProjectionSchema>;

export const installationRouteInputSchema = z
  .object({
    kind: z.enum(["local", "direct", "tunnel"]),
    address: z.string().url().max(2048),
    deviceId: id.nullable(),
  })
  .strict()
  .refine(
    (route) => {
      const url = new URL(route.address);
      if (url.origin !== route.address || url.username || url.password) return false;
      return route.kind === "local"
        ? route.deviceId !== null &&
            ["127.0.0.1", "[::1]"].includes(url.hostname) &&
            ["http:", "https:"].includes(url.protocol)
        : route.deviceId === null && !isLoopbackHost(url.hostname) && url.protocol === "https:";
    },
    { message: "Invalid installation route" },
  );
export const installationRoutesInputSchema = z
  .array(installationRouteInputSchema)
  .max(8)
  .refine((routes) => new Set(routes.map((route) => route.address)).size === routes.length);

export const identityCatalogSchema = z
  .object({
    version: z.literal(2),
    defaultOrganizationId: id.nullable(),
    organizations: z.array(
      z
        .object({
          id,
          name: z.string(),
          type: z.enum(["personal", "shared"]),
          role: z.enum(["admin", "manager", "member"]),
          servers: z.array(
            z
              .object({
                id,
                name: z.string(),
                bindingVersion: positive,
                keyFingerprint: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .nullable(),
                state: z.enum(["pending", "ready", "failed", "disconnected", "update-required"]),
                routes: z.array(
                  z
                    .object({
                      id,
                      kind: z.enum(["local", "direct", "tunnel"]),
                      address: z.string().url().max(2048),
                      deviceId: id.nullable(),
                    })
                    .strict(),
                ),
                workspaces: z.array(
                  z
                    .object({
                      id,
                      name: z.string(),
                      state: z.enum(["provisioning", "ready", "failed", "disabled"]),
                      canOpen: z.boolean(),
                      role: workspaceAccessRoleSchema.nullable(),
                    })
                    .strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type IdentityCatalog = z.infer<typeof identityCatalogSchema>;
export type IdentityWorkspace =
  IdentityCatalog["organizations"][number]["servers"][number]["workspaces"][number];

export interface InstallationRequestProof {
  serverId: string;
  bindingVersion: number;
  timestamp: number;
  nonce: string;
}

/** The private key stays on the installation; this defines only the signed request bytes. */
export function installationRequestMessage(
  proof: InstallationRequestProof,
  method: string,
  path: string,
  bodyHash: string,
): string {
  return JSON.stringify([
    "ork-installation-request-v2",
    method,
    path,
    proof.serverId,
    proof.bindingVersion,
    proof.timestamp,
    proof.nonce,
    bodyHash,
  ]);
}
