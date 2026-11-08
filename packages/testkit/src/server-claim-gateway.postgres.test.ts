// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { runAsSystem } from "@orkbot/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGateway } from "../../../apps/web/src/gateway/server.js";
import { issueServerClaim } from "../../auth/src/server-claim.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "https://server.example.test";
const issuer = "https://api.orkbot.run";
const bootstrapSecret = "s".repeat(43);
const id = "a".repeat(64);
const proofNonce = "p".repeat(43);

describe.skipIf(!enabled)(
  "public server authorization proof through the production gateway",
  () => {
    let cleanup: (() => Promise<void>) | undefined;
    afterAll(async () => {
      await cleanup?.();
      vi.unstubAllGlobals();
    });

    it("forwards an anonymous exact-host proof to the real API without a session", async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ork-claim-gateway-"));
      await mkdir(path.join(root, "dist/assets"), { recursive: true });
      await writeFile(path.join(root, "dist/build-id"), "fixture\n");
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith(issuer))
          return Promise.resolve(
            Response.json(
              { status: "pending", expiresAt: Math.floor(Date.now() / 1000) + 300 },
              { status: 202 },
            ),
          );
        return realFetch(input, init);
      });
      const { createApp } = await import("@orkbot/api/app");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        dataDir: root,
        authUrl: origin,
        webOrigin: origin,
        passwordAuth: false,
        accountsEnabled: true,
        bootstrapSecret,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        wakeupDriver: "memory",
        signupsEnabled: "false",
      });
      let seen:
        | { origin: string | null; cookie: string | null; authorization: string | null }
        | undefined;
      const api = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          seen = {
            origin: request.headers.get("origin"),
            cookie: request.headers.get("cookie"),
            authorization: request.headers.get("authorization"),
          };
          return handles.app.fetch(request);
        },
      });
      await new Promise<void>((resolve) => api.once("listening", resolve));
      const apiPort = (api.address() as AddressInfo).port;
      const gateway = createGateway({
        root,
        api: `http://127.0.0.1:${apiPort}`,
        screenSecret: "fake-screen-proxy-secret-0123456789",
        allowedHosts: ["server.example.test"],
      });
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      const gatewayPort = (gateway.address() as AddressInfo).port;
      cleanup = async () => {
        await gateway.shutdown(0);
        await new Promise<void>((resolve) => api.close(() => resolve()));
        await handles.stop();
        await rm(root, { recursive: true, force: true });
      };
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      const request = vi.fn(async () =>
        Response.json(
          { id, origin, receipt: "r".repeat(43), proofNonce, code: "ABCDEFGHJK", expiresAt },
          { status: 201 },
        ),
      ) as typeof fetch;
      await runAsSystem("server claim gateway fixture", () =>
        issueServerClaim(handles.prisma, { issuer, origin, bootstrapSecret, request }),
      );
      const payload = JSON.stringify({ id, proofNonce });
      const response = await new Promise<{
        status: number;
        body: string;
        cache: string | string[] | undefined;
        cookie: string[] | undefined;
      }>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: gatewayPort,
            path: "/api/auth/native/claim-proof",
            method: "POST",
            headers: {
              host: "server.example.test",
              "x-forwarded-proto": "https",
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
                cache: res.headers["cache-control"],
                cookie: res.headers["set-cookie"],
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        id,
        proofNonce,
        status: "pending",
        organizationBinding: true,
      });
      expect(response.cache).toBe("no-store");
      expect(response.cookie).toBeUndefined();
      expect(seen).toEqual({ origin: null, cookie: null, authorization: null });
    }, 30_000);
  },
);
