// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 installer coverage is preserved; bounded download recovery follows LICENSE.md.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shellQuote } from "./computer-support.js";
import {
  installAgentBrowserCommand,
  installPageBrowserFilesCommand,
} from "./page-browser-install.js";

const computer = path.resolve(import.meta.dirname, "../../../infra/sandboxes/computer");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Runs a setup script with /usr/local moved under a scratch folder and no sudo. */
function runUnder(script: string, folder: string) {
  return execFileSync(
    "bash",
    ["-c", script.replaceAll("/usr/local", `${folder}/usr/local`).replaceAll('"sudo -n"', '""')],
    { encoding: "utf8" },
  );
}

it("writes this release's page-browser files once, and again when they differ", () => {
  root = mkdtempSync(path.join(tmpdir(), "page-browser-install-"));
  execFileSync("mkdir", ["-p", `${root}/usr/local/bin`]);
  const wrapper = `${root}/usr/local/bin/orkbot-page-browser`;
  const secrets = `${root}/usr/local/lib/orkbot/page_secrets.py`;

  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(wrapper, "utf8")).toBe(
    readFileSync(path.join(computer, "orkbot-page-browser"), "utf8"),
  );
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
  expect(statSync(wrapper).mode & 0o777).toBe(0o755);
  expect(statSync(secrets).mode & 0o777).toBe(0o644);

  // A computer already on this release keeps its files untouched.
  writeFileSync(secrets, "edited");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe("edited");

  // One from another release gets this release's copy.
  writeFileSync(`${root}/usr/local/lib/orkbot/page-browser.version`, "older");
  runUnder(installPageBrowserFilesCommand(), root);
  expect(readFileSync(secrets, "utf8")).toBe(
    readFileSync(path.join(computer, "page_secrets.py"), "utf8"),
  );
});

it("installs agent-browser with the computer image's pinned script", () => {
  expect(installAgentBrowserCommand()).toContain(
    shellQuote(readFileSync(path.join(computer, "install-agent-browser.sh"), "utf8")),
  );
});

const pinnedInstaller = readFileSync(path.join(computer, "install-agent-browser.sh"), "utf8");
const fixtureBinary = "#!/bin/sh\nprintf 'fixture browser 0.0.0\\n'\n";
const fixtureHash = createHash("sha256").update(fixtureBinary).digest("hex");
const executable = (name: string) =>
  execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

async function downloadHarness(
  respond: (attempt: number, response: ServerResponse) => void,
  options: {
    existing?: string;
    architecture?: string;
    attemptSeconds?: string;
    refuseFirstConnection?: boolean;
  } = {},
) {
  root = mkdtempSync(path.join(tmpdir(), "browser-download-"));
  const folder = root;
  const bin = path.join(folder, "bin"),
    dest = path.join(folder, "dest"),
    temporary = path.join(folder, "tmp");
  for (const directory of [bin, dest, temporary]) mkdirSync(directory);
  if (options.existing !== undefined)
    writeFileSync(path.join(dest, "agent-browser"), options.existing, { mode: 0o755 });
  const script = path.join(folder, "installer.sh");
  // Only the test-executed copy uses a fixture digest. Production release pins stay unchanged.
  writeFileSync(script, pinnedInstaller.replace(/sha256=[a-f0-9]{64}/g, `sha256=${fixtureHash}`));
  const curlLog = path.join(folder, "curl.json"),
    installLog = path.join(folder, "installed");
  const curl = executable("curl"),
    install = executable("install"),
    sha256sum = executable("sha256sum");
  // The macOS checksum tool lacks GNU --status; retain a real checksum comparison on both hosts.
  writeFileSync(
    path.join(bin, "sha256sum"),
    `#!/bin/sh
if [ "$#" -eq 2 ] && [ "$1" = "-c" ] && [ "$2" = "--status" ]; then
  exec ${shellQuote(sha256sum)} -c - >/dev/null
fi
exec ${shellQuote(sha256sum)} "$@"
`,
    { mode: 0o755 },
  );
  const version = /^version=(.+)$/m.exec(pinnedInstaller)![1];
  const architecture = options.architecture ?? "x86_64";
  const expectedUrl = `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-linux-${architecture === "arm64" ? "arm64" : "x64"}`;
  writeFileSync(
    path.join(bin, "uname"),
    `#!/bin/sh\nprintf '%s\\n' ${shellQuote(architecture)}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(bin, "install"),
    `#!/bin/sh\nprintf 'install\\n' >> ${shellQuote(installLog)}\nexec ${shellQuote(install)} "$@"\n`,
    { mode: 0o755 },
  );
  const sockets = new Set<Socket>();
  let attempts = 0;
  const server = createServer((_request, response) => respond(++attempts, response));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const localUrl = `http://127.0.0.1:${port}/binary`;
  if (options.refuseFirstConnection) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  const shim = path.join(folder, "curl.cjs");
  writeFileSync(
    shim,
    `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(curlLog)}, JSON.stringify(args));
const index = args.indexOf(${JSON.stringify(expectedUrl)});
if (index < 0 || args.filter(value => /^https?:/.test(value)).length !== 1) process.exit(98);
args[index] = ${JSON.stringify(localUrl)};
const timeout = ${JSON.stringify(options.attemptSeconds ?? "")};
// Keep the real curl retry engine, isolating only origin, local curlrc/proxy settings and test duration.
const result = spawnSync(${JSON.stringify(curl)}, ["--disable", ...args, "--noproxy", "*", ...(timeout ? ["--connect-timeout", timeout, "--max-time", timeout, "--retry-max-time", "5"] : [])], { stdio: "inherit" });
process.exit(result.status ?? 99);
`,
  );
  writeFileSync(
    path.join(bin, "curl"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(shim)} "$@"\n`,
    { mode: 0o755 },
  );
  try {
    let reopening: Promise<void> | undefined;
    const result = await new Promise<{ status: number; stderr: string; stdout: string }>((done) => {
      const child = execFile(
        "sh",
        [script, dest],
        {
          encoding: "utf8",
          timeout: 8000,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary },
        },
        (error, stdout, stderr) =>
          done({
            status: error ? (typeof error.code === "number" ? error.code : -1) : 0,
            stdout,
            stderr,
          }),
      );
      if (options.refuseFirstConnection) {
        let errors = "";
        child.stderr?.on("data", (chunk) => {
          errors = (errors + String(chunk)).slice(-1024);
          if (!reopening && errors.includes("curl: (7)")) {
            reopening = new Promise<void>((ready) => server.listen(port, "127.0.0.1", ready));
          }
        });
      }
    });
    await reopening;
    return {
      ...result,
      attempts,
      files: readdirSync(temporary),
      installed: existsSync(installLog)
        ? readFileSync(installLog, "utf8").trim().split("\n").length
        : 0,
      bytes: existsSync(path.join(dest, "agent-browser"))
        ? readFileSync(path.join(dest, "agent-browser"), "utf8")
        : undefined,
      mode: existsSync(path.join(dest, "agent-browser"))
        ? statSync(path.join(dest, "agent-browser")).mode & 0o777
        : undefined,
      curlArgs: existsSync(curlLog) ? (JSON.parse(readFileSync(curlLog, "utf8")) as string[]) : [],
    };
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe("pinned browser download recovery", () => {
  it("recovers after an actual refused loopback connection", async () => {
    const result = await downloadHarness((_attempt, response) => response.end(fixtureBinary), {
      refuseFirstConnection: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("curl: (7)");
    expect(result.attempts).toBe(1);
    expect(result.installed).toBe(1);
    expect(result.files).toEqual([]);
  });
  it("does not let a remote Retry-After exceed the retry window", async () => {
    const result = await downloadHarness(
      (_attempt, response) => response.writeHead(503, { "retry-after": "3600" }).end("unavailable"),
      { existing: "previous binary", attemptSeconds: "0.5" },
    );
    expect(result.status).toBe(22);
    expect(result.attempts).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.bytes).toBe("previous binary");
    expect(result.files).toEqual([]);
  });
  it.each([503, 429])(
    "retries a transient HTTP %s then installs only verified bytes",
    async (status) => {
      const result = await downloadHarness(
        (attempt, response) => {
          if (attempt === 1) response.writeHead(status).end("temporary failure");
          else response.end(fixtureBinary);
        },
        { existing: "previous binary" },
      );
      expect(result.status).toBe(0);
      expect(result.attempts).toBe(2);
      expect(result.installed).toBe(1);
      expect(result.bytes).toBe(fixtureBinary);
      expect(result.mode).toBe(0o755);
      expect(result.files).toEqual([]);
      for (const [flag, value] of [
        ["--retry", "2"],
        ["--retry-max-time", "180"],
        ["--connect-timeout", "10"],
        ["--max-time", "60"],
      ] as const) {
        expect(result.curlArgs[result.curlArgs.indexOf(flag) + 1]).toBe(value);
      }
      expect(result.curlArgs).toContain("--retry-connrefused");
      expect(result.curlArgs).not.toContain("--retry-all-errors");
    },
  );
  it("bounds retry exhaustion and leaves the old binary untouched", async () => {
    const result = await downloadHarness(
      (_attempt, response) => response.writeHead(503).end("temporary failure"),
      { existing: "previous binary" },
    );
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.installed).toBe(0);
    expect(result.bytes).toBe("previous binary");
    expect(result.files).toEqual([]);
  });
  it.each([401, 403, 404])("does not retry permanent HTTP %s", async (status) => {
    const result = await downloadHarness(
      (_attempt, response) => response.writeHead(status).end("permanent failure"),
      { existing: "previous binary" },
    );
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.bytes).toBe("previous binary");
    expect(result.files).toEqual([]);
  });
  it("never retries a successful transfer with a corrupt checksum", async () => {
    const result = await downloadHarness((_attempt, response) => response.end("corrupt payload"), {
      existing: "previous binary",
    });
    expect(result.status).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.installed).toBe(0);
    expect(result.bytes).toBe("previous binary");
    expect(result.files).toEqual([]);
  });
  it("retries a timed-out transfer using the same bounded engine", async () => {
    const result = await downloadHarness(
      (attempt, response) => {
        if (attempt > 1) response.end(fixtureBinary);
      },
      { attemptSeconds: "0.5" },
    );
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.bytes).toBe(fixtureBinary);
    expect(result.files).toEqual([]);
  });
  it("keeps an already verified binary without creating a download or reinstall", async () => {
    const result = await downloadHarness((_attempt, response) => response.end("unexpected"), {
      existing: fixtureBinary,
    });
    expect(result.status).toBe(0);
    expect(result.attempts).toBe(0);
    expect(result.installed).toBe(0);
    expect(result.curlArgs).toEqual([]);
    expect(result.files).toEqual([]);
  });
  it("rejects unsupported architecture before downloading", async () => {
    const result = await downloadHarness((_attempt, response) => response.end("unexpected"), {
      architecture: "unsupported",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsupported architecture");
    expect(result.attempts).toBe(0);
    expect(result.files).toEqual([]);
  });
  it("keeps the architecture-specific pinned URL and fixture verification for arm64", async () => {
    const result = await downloadHarness((_attempt, response) => response.end(fixtureBinary), {
      architecture: "arm64",
    });
    expect(result.status).toBe(0);
    expect(result.curlArgs.at(-3)).toContain("agent-browser-linux-arm64");
    expect(result.bytes).toBe(fixtureBinary);
  });
});
