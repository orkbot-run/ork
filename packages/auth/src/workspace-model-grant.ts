// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createHash } from "node:crypto";
import { readBoundedJsonResponse } from "@orkbot/core";
import type { JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

export const WORKSPACE_MODEL_GRANT_PURPOSE = "ork-workspace-model-v1";
export const workspaceModelRequestHash = (action: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([action, input ?? null]))
    .digest("hex");

/** Verify a short-lived, request-bound authority issued by the server's configured Accounts issuer. */
export function createWorkspaceModelGrantVerifier(options: {
  issuer: string;
  origin: string;
  keys?: JWTVerifyGetKey;
}) {
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL("/api/auth/jwks", options.issuer), {
      timeoutDuration: 8_000,
      cacheMaxAge: 300_000,
      cooldownDuration: 30_000,
      [customFetch]: async (url, init) => {
        const response = await fetch(url, { ...init, credentials: "omit", redirect: "error" });
        return response.status === 200
          ? Response.json(await readBoundedJsonResponse(response, 64 * 1024))
          : response;
      },
    });
  return async (grant: string, action: string, input: unknown) => {
    const { payload } = await jwtVerify(grant, keys, {
      issuer: options.issuer,
      audience: options.origin,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "sub", "jti", "iat", "exp", "purpose"],
      maxTokenAge: "60s",
      clockTolerance: 5,
    });
    if (
      payload.aud !== options.origin ||
      payload.purpose !== WORKSPACE_MODEL_GRANT_PURPOSE ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 1024 ||
      typeof payload.jti !== "string" ||
      !/^[a-f0-9-]{36}$/.test(payload.jti) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp > payload.iat + 60 ||
      typeof payload.organization_id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        payload.organization_id,
      ) ||
      typeof payload.claim_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.claim_id) ||
      payload.request_hash !== workspaceModelRequestHash(action, input)
    )
      throw new Error("Invalid workspace model grant");
    return {
      id: payload.jti,
      subject: payload.sub,
      organizationId: payload.organization_id,
      claimId: payload.claim_id,
      expiresAt: payload.exp,
    };
  };
}
