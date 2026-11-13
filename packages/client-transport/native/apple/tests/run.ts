// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { chmodSync, globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InstallationTransport } from "../../../../adapters/src/installation-transport.js";
import { createInstallationTlsIdentity } from "../../../../auth/src/installation-tls.js";

const directory = mkdtempSync(join(tmpdir(), "ork-transport-conformance-"));
chmodSync(directory, 0o700);
const sockets = new Set<Socket>();
const track = (socket: Socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
};
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const fingerprint = createHash("sha256")
  .update(keys.publicKey.export({ format: "der", type: "spki" }))
  .digest("hex");
const identity = {
  ...(await createInstallationTlsIdentity(keys.privateKey, fingerprint)),
  serverId: "10000000-0000-4000-8000-000000000001",
  bindingVersion: 1,
  keyFingerprint: fingerprint,
};
const backend = createServer();
backend.on("connection", track);
backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const backendPort = (backend.address() as { port: number }).port;
const capture: Buffer[] = [];
const proxy = createTcpServer((client) => {
  const server = connect(backendPort, "127.0.0.1");
  track(client);
  track(server);
  client.on("data", (bytes) => capture.push(Buffer.from(bytes)));
  server.on("data", (bytes) => capture.push(Buffer.from(bytes)));
  client.on("error", () => server.destroy());
  server.on("error", () => client.destroy());
  client.on("close", () => server.destroy());
  server.on("close", () => client.destroy());
  client.pipe(server);
  server.pipe(client);
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
let canceled = 0;
let uploads = 0;
const cancellation = Promise.withResolvers<void>();
const adapter = new InstallationTransport({
  origin,
  identity: async () => identity,
  listener: async (req, res) => {
    if (req.headers.authorization !== "Bearer native-conformance-token") {
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/files") {
      let size = 0;
      for await (const part of req) {
        if (![...part].every((byte) => byte === 0x42)) throw Error("wrong upload");
        size += part.length;
      }
      if (size !== 2 * 1024 * 1024) {
        res.writeHead(400).end();
        return;
      }
      uploads++;
      res.writeHead(201, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(2 * 1024 * 1024, 0x43));
      return;
    }
    if (req.url === "/events" || req.url === "/cancel") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: private-event-first\n\n");
      if (req.url === "/events") setTimeout(() => res.end("data: private-event-last\n\n"), 30);
      else
        res.once("close", () => {
          canceled++;
          cancellation.resolve();
        });
      return;
    }
    if (req.url === "/checks") {
      await Promise.race([
        cancellation.promise,
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
      const all = Buffer.concat(capture);
      const opaque =
        !all.includes("native-conformance-token") &&
        !all.includes("private-event-first") &&
        !all.includes("/files HTTP/1.1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ uploads, canceled, opaque }));
      return;
    }
    res.writeHead(404).end();
  },
});
backend.on("upgrade", adapter.handleUpgrade);

const source = dirname(fileURLToPath(import.meta.url));
const native = resolve(source, "../..");
const bindings = resolve(process.argv[2] ?? "");
const library = join(native, "target/debug");
const endpoint = join(directory, "endpoint.json");
const executable = join(directory, "conformance");
writeFileSync(
  endpoint,
  JSON.stringify({ origin, serverId: identity.serverId, bindingVersion: 1, fingerprint }),
  { mode: 0o600 },
);
async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Native conformance failed (${code ?? signal})`));
    });
  });
}
try {
  if (!process.argv[2]) throw new Error("Pass the generated Swift bindings directory");
  await run("xcrun", [
    "swiftc",
    "-parse-as-library",
    "-I",
    bindings,
    "-Xcc",
    `-fmodule-map-file=${join(bindings, "ork_installation_transportFFI.modulemap")}`,
    join(bindings, "ork_installation_transport.swift"),
    ...globSync("apple/*.swift", { cwd: native })
      .sort()
      .map((file) => join(native, file)),
    join(source, "Conformance.swift"),
    "-L",
    library,
    "-lork_installation_transport",
    "-Xlinker",
    "-rpath",
    "-Xlinker",
    library,
    "-o",
    executable,
  ]);
  await run(executable, [endpoint]);
} finally {
  adapter.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [proxy, backend].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  rmSync(directory, { recursive: true, force: true });
}
