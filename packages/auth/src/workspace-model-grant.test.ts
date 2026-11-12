// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import {
  createWorkspaceModelGrantVerifier,
  workspaceModelRequestHash,
} from "./workspace-model-grant.js";

it("accepts only a short-lived, audience- and request-bound Accounts grant", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] });
  const issuer = "https://accounts.example.test";
  const origin = "https://server.example.test";
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const claimId = "a".repeat(64);
  const input = { provider: "example", modelId: "example-model", apiKey: "fake-test-key" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: origin,
    sub: "owner",
    jti: "00000000-0000-4000-8000-000000000001",
    iat: now,
    exp: now + 60,
    purpose: "ork-workspace-model-v1",
    organization_id: organizationId,
    claim_id: claimId,
    request_hash: workspaceModelRequestHash("set", input),
  };
  const sign = (fields: Record<string, unknown>) =>
    new SignJWT(fields).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(privateKey);
  const verify = createWorkspaceModelGrantVerifier({ issuer, origin, keys });
  const grant = await sign(payload);
  await expect(verify(grant, "set", input)).resolves.toMatchObject({ organizationId, claimId });
  await expect(verify(grant, "clear", input)).rejects.toThrow();
  await expect(verify(grant, "set", { ...input, modelId: "other" })).rejects.toThrow();
  await expect(
    verify(await sign({ ...payload, aud: "https://other.example.test" }), "set", input),
  ).rejects.toThrow();
  await expect(
    verify(await sign({ ...payload, iss: "https://other.example.test" }), "set", input),
  ).rejects.toThrow();
  await expect(
    verify(await sign({ ...payload, purpose: "other" }), "set", input),
  ).rejects.toThrow();
  await expect(verify(await sign({ ...payload, exp: now + 61 }), "set", input)).rejects.toThrow();
  await expect(
    verify(await sign({ ...payload, exp: now - 10, iat: now - 30 }), "set", input),
  ).rejects.toThrow();
});
