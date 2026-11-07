// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

let temporary: string;
let application: string;
let apiOrigin: string;
let apiServer: http.Server;
const processes: ChildProcess[] = [];
beforeAll(async () => {
  temporary = await realpath(await mkdtemp(path.join(tmpdir(), "ork-gateway-cli-")));
  application = path.join(temporary, "application");
  apiServer = http.createServer((_req, res) => res.end("api from env file"));
  await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
  apiOrigin = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  await mkdir(path.join(application, "dist/assets"), { recursive: true });
  await mkdir(path.join(application, "launcher"));
  await writeFile(path.join(application, "dist/index.html"), "<!doctype html>gateway shell");
  const helper = pathToFileURL(
    fileURLToPath(new URL("../../scripts/build-gateway.mjs", import.meta.url)),
  ).href;
  await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    "const {buildGateway}=await import(process.argv[1]); await buildGateway(process.argv[2]);",
    helper,
    path.join(application, "server/index.js"),
  ]);
});
afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null) continue;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  }
});
afterAll(async () => {
  apiServer.closeAllConnections();
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  await rm(temporary, { recursive: true, force: true });
});

async function port() {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function start(extra: Record<string, string> = {}, args: string[] = []) {
  const listenPort = await port();
  await writeFile(
    path.join(application, ".env"),
    `WEB_PORT=${listenPort}\nAPI_PROXY_TARGET=${apiOrigin}\nORKBOT_HOST=file.example.test\nSCREEN_PROXY_SECRET=fake-gateway-cli-secret-0123456789abcdef\nORKBOT_DESKTOP_STACK_TOKEN=file-proof\nORKBOT_IMAGE_TAG=file-tag\n`,
  );
  const child = spawn(
    process.execPath,
    [path.join(application, "server/index.js"), "--host", "127.0.0.1", ...args],
    {
      cwd: path.join(application, "launcher"),
      env: { PATH: process.env.PATH, NODE_ENV: "production", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processes.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  child.stdout?.resume();
  const actualPort = Number(extra.WEB_PORT ?? listenPort);
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await get(actualPort, "/", extra.ORKBOT_HOST ?? "file.example.test");
      break;
    } catch {
      if (Date.now() >= deadline || child.exitCode !== null)
        throw new Error(`Gateway did not start: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  return actualPort;
}

function get(port: number, pathname: string, host: string, proof?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: pathname,
          headers: { Host: host, ...(proof ? { "x-orkbot-desktop-stack-token": proof } : {}) },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString();
          });
          res.once("end", () => resolve({ status: res.statusCode!, body }));
        },
      )
      .once("error", reject);
  });
}

it("starts the built gateway from another working directory using the nearest .env", async () => {
  const listenPort = await start();
  expect((await get(listenPort, "/rpc/health", "file.example.test")).body).toBe(
    "api from env file",
  );
  expect(await get(listenPort, "/app", "file.example.test")).toEqual({
    status: 200,
    body: "<!doctype html>gateway shell",
  });
  const probe = await get(
    listenPort,
    "/.well-known/orkbot-desktop-stack",
    "file.example.test",
    "file-proof",
  );
  expect(JSON.parse(probe.body)).toEqual({ ok: true, imageTag: "file-tag" });
  expect((await get(listenPort, "/", "other.example.test")).status).toBe(403);
});

it("keeps explicit environment settings ahead of the local env file", async () => {
  const listenPort = await start({
    WEB_PORT: String(await port()),
    ORKBOT_HOST: "explicit.example.test",
    ORKBOT_IMAGE_TAG: "explicit-tag",
  });
  expect((await get(listenPort, "/", "file.example.test")).status).toBe(403);
  const probe = await get(
    listenPort,
    "/.well-known/orkbot-desktop-stack",
    "explicit.example.test",
    "file-proof",
  );
  expect(JSON.parse(probe.body)).toEqual({ ok: true, imageTag: "explicit-tag" });
});

it("does not read a developer env file when the runtime is an isolated test", async () => {
  const listenPort = await start({
    NODE_ENV: "test",
    WEB_PORT: String(await port()),
    ORKBOT_HOST: "isolated.example.test",
    SCREEN_PROXY_SECRET: "fake-isolated-screen-secret-0123456789",
    ORKBOT_DESKTOP_STACK_TOKEN: "isolated-proof",
  });
  expect(
    (
      await get(
        listenPort,
        "/.well-known/orkbot-desktop-stack",
        "isolated.example.test",
        "file-proof",
      )
    ).status,
  ).toBe(404);
  const probe = await get(
    listenPort,
    "/.well-known/orkbot-desktop-stack",
    "isolated.example.test",
    "isolated-proof",
  );
  expect(JSON.parse(probe.body).imageTag).toBe("edge");
});
