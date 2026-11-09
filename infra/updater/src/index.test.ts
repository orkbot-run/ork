// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache tests are preserved; Ork recovery qualification changes follow LICENSE.md.

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@orkbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentJournal } from "./deployment-journal.js";
import type { UpdaterCommandRunner } from "./index.js";
import {
  commandEnvironment,
  createUpdaterApp,
  restoreCheckoutArgv,
  runHostCommand,
} from "./index.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-review-updater-token-000000000000";
const app = createUpdaterApp(
  resolveUpdaterConfig({
    ORKBOT_DEPLOY_DIR: "/orkbot-updater-tests-no-such-directory",
    ORKBOT_UPDATER_TOKEN: token,
  }),
);
const authorized = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const currentCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function deployment(env = "ORKBOT_IMAGE_TAG=v1.0.0\nORKBOT_IMAGE_TAG_PREVIOUS=v0.9.0\n") {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "orkbot-updater-test-"));
  temporaryDirectories.push(deployDir);
  await writeFile(path.join(deployDir, ".env"), env);
  return {
    deployDir,
    config: resolveUpdaterConfig({ ORKBOT_DEPLOY_DIR: deployDir, ORKBOT_UPDATER_TOKEN: token }),
  };
}

function ok(output = "") {
  return { ok: true, exitCode: 0, stdout: output, output };
}

function failed(output: string) {
  return { ok: false, exitCode: 1, stdout: "", output };
}

function request(app: ReturnType<typeof createUpdaterApp>, pathname: string, body?: unknown) {
  return app.request(pathname, {
    method: "POST",
    headers: authorized,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("updater HTTP surface", () => {
  it("answers health without credentials, for the compose healthcheck", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "updater" });
  });

  it("rejects every privileged route without the shared token", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/state"],
      ["POST", "/plan"],
      ["POST", "/apply"],
      ["POST", "/rollback"],
      ["POST", "/deploy"],
    ];
    for (const [method, pathname] of routes) {
      const response = await app.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a wrong or malformed token", async () => {
    for (const authorization of [`Bearer ${"x".repeat(token.length)}`, token, "Basic abc"]) {
      const response = await app.request("/state", { headers: { authorization } });
      expect(response.status).toBe(401);
    }
  });

  it("re-validates the repository URL at its own boundary", async () => {
    const cases = [
      "http://github.com/a/b",
      "file:///etc/passwd",
      "https://user:pw@github.com/a/b",
      "--upload-pack=id",
      "https://github.com/a/b?x=1",
    ];
    for (const repoUrl of cases) {
      const response = await app.request("/apply", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({ repoUrl, branch: "main" }),
      });
      expect(response.status, repoUrl).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error, repoUrl).toBeTruthy();
    }
  });

  it("re-validates the branch at its own boundary", async () => {
    const response = await app.request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/orkbot-run/ork", branch: "--exec=id" }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses a fork build when the deployment has no checkout to build from", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/someone/orkbot", branch: "main" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/no \.git directory/);
  });

  it("refuses a rollback when no previous tag was recorded", async () => {
    const fixture = await deployment("ORKBOT_IMAGE_TAG=v1.0.0\n");
    const response = await createUpdaterApp(fixture.config).request("/rollback", {
      method: "POST",
      headers: authorized,
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/nothing to roll back/);
  });

  it("reports the deployment it manages without touching Docker", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/state", {
      headers: authorized,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployDir: fixture.deployDir,
      currentTag: "v1.0.0",
      previousTag: "v0.9.0",
      checkout: { present: false },
    });
  });

  it("fails closed when the deployment environment cannot be read", async () => {
    const response = await app.request("/state", { headers: authorized });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/\.env/) });
  });

  it("refuses a failed plan without leaving a rejection that could stop the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const subject = createUpdaterApp(
        resolveUpdaterConfig({
          ORKBOT_DEPLOY_DIR: "/orkbot-updater-tests-no-such-directory",
          ORKBOT_UPDATER_TOKEN: token,
        }),
      );
      const input = { repoUrl: "https://github.com/orkbot-run/ork", branch: "main" };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request(subject, "/plan", input);
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringMatching(/\.env/),
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("standalone deployment acknowledgements", () => {
  async function preparedDeployment() {
    const fixture = await deployment();
    const template = path.join(fixture.deployDir, "docker-compose.images.yml");
    const before = "old-compose";
    const after = "new-compose";
    const metadata = path.join(fixture.deployDir, ".orkbot-compose-state.json");
    await writeFile(template, before);
    await writeFile(
      metadata,
      JSON.stringify({
        files: { "docker-compose.images.yml": createHash("sha256").update(before).digest("hex") },
      }),
    );
    const fetch = async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      if (url.includes("/releases?"))
        return Response.json([{ tag_name: "v1.2.3", draft: false, prerelease: false }]);
      if (url.includes("/compare/")) return Response.json({ status: "ahead" });
      if (url.includes("/token?")) return Response.json({ token: "fixture-token" });
      if (url.includes("/manifests/"))
        return new Response(null, {
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "docker-content-digest": `sha256:${"b".repeat(64)}`,
          },
        });
      if (url.includes("/actions/workflows/"))
        return Response.json({
          workflow_runs: [
            {
              head_sha: targetCommit,
              event: "push",
              head_branch: "main",
              status: "completed",
              conclusion: "success",
            },
          ],
        });
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(after);
      throw new Error("Unexpected request");
    };
    return { ...fixture, fetch, template, before, after, metadata };
  }

  it.each(["accepted", "running", "unknown"] as const)(
    "reconciles %s to success only after all target services and templates match",
    async (state) => {
      const fixture = await preparedDeployment();
      await writeFile(`${fixture.template}.update-backup`, fixture.before);
      await writeFile(fixture.template, fixture.after);
      await writeFile(
        path.join(fixture.deployDir, ".env"),
        `ORKBOT_IMAGE_TAG=sha-${targetCommit}\n`,
      );
      await new DeploymentJournal(fixture.deployDir).write({
        revision: targetCommit,
        idempotencyKey: "reconcile-operation-001",
        state,
      });
      const imageId = `sha256:${"d".repeat(64)}`;
      const run: UpdaterCommandRunner = async (_command, args) => {
        if (args[0] === "image") return ok(imageId);
        if (args.includes("ps")) return ok("a".repeat(64));
        if (args[0] === "inspect") return ok(`${imageId} running healthy`);
        throw new Error("Unexpected command");
      };
      const subject = createUpdaterApp(
        {
          ...fixture.config,
          mode: "standalone",
          updateServices: ["api", "worker", "web", "supervisor"],
        },
        { run, fetch: fixture.fetch },
      );
      const response = await subject.request("/state", { headers: authorized });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { operation: { state: string } }).operation.state).toBe(
        "succeeded",
      );
      expect((await new DeploymentJournal(fixture.deployDir).read())?.state).toBe("succeeded");
      expect(
        JSON.parse(await readFile(fixture.metadata, "utf8")).files["docker-compose.images.yml"],
      ).toBe(createHash("sha256").update(fixture.after).digest("hex"));
      await expect(lstat(`${fixture.template}.update-backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("keeps an interrupted mixed-version runtime unknown without changing templates", async () => {
    const fixture = await preparedDeployment();
    await writeFile(`${fixture.template}.update-backup`, fixture.before);
    await writeFile(fixture.template, fixture.after);
    await writeFile(path.join(fixture.deployDir, ".env"), `ORKBOT_IMAGE_TAG=sha-${targetCommit}\n`);
    await new DeploymentJournal(fixture.deployDir).write({
      revision: targetCommit,
      idempotencyKey: "reconcile-operation-002",
      state: "running",
    });
    const imageId = `sha256:${"d".repeat(64)}`;
    let inspected = 0;
    const run: UpdaterCommandRunner = async (_command, args) => {
      if (args[0] === "image") return ok(imageId);
      if (args.includes("ps")) return ok("a".repeat(64));
      if (args[0] === "inspect")
        return ok(`${++inspected === 2 ? `sha256:${"e".repeat(64)}` : imageId} running healthy`);
      throw new Error("Unexpected command");
    };
    const subject = createUpdaterApp(
      {
        ...fixture.config,
        mode: "standalone",
        updateServices: ["api", "worker", "web", "supervisor"],
      },
      { run, fetch: fixture.fetch },
    );
    const response = await subject.request("/state", { headers: authorized });
    expect(((await response.json()) as { operation: { state: string } }).operation.state).toBe(
      "unknown",
    );
    expect((await new DeploymentJournal(fixture.deployDir).read())?.state).toBe("unknown");
    expect(await readFile(`${fixture.template}.update-backup`, "utf8")).toBe(fixture.before);
    expect(await readFile(fixture.template, "utf8")).toBe(fixture.after);
  });

  it("acknowledges before a deployment completes and commits the staged templates", async () => {
    const fixture = await preparedDeployment();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pullReached!: () => void;
    const pull = new Promise<void>((resolve) => {
      pullReached = resolve;
    });
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.2.3\n`);
      if (args.includes("exec")) return ok(currentCommit);
      if (args.includes("pull")) {
        pullReached();
        await gate;
      }
      return ok();
    };
    const subject = createUpdaterApp(
      { ...fixture.config, mode: "standalone" },
      { run, fetch: fixture.fetch },
    );
    const response = await request(subject, "/deploy", {
      revision: targetCommit,
      idempotencyKey: "happy-operation-0001",
      channel: "preview",
    });
    expect(response.status).toBe(202);
    await pull;
    expect((await new DeploymentJournal(fixture.deployDir).read())?.state).toBe("running");
    release();
    await vi.waitFor(async () =>
      expect((await new DeploymentJournal(fixture.deployDir).read())?.state).toBe("succeeded"),
    );
    expect(await readFile(fixture.template, "utf8")).toBe(fixture.after);
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      `ORKBOT_IMAGE_TAG=sha-${targetCommit}`,
    );
    expect(
      JSON.parse(await readFile(fixture.metadata, "utf8")).files["docker-compose.images.yml"],
    ).toBe(createHash("sha256").update(fixture.after).digest("hex"));
  });

  it("restores original templates before attempting cached-image recovery after recreate fails", async () => {
    const fixture = await preparedDeployment();
    let recreates = 0;
    let recoveryTemplate = "";
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.2.3\n`);
      if (args.includes("exec")) return ok(currentCommit);
      if (args.includes("up")) {
        recreates++;
        if (recreates === 1) return failed("recreate failed");
        recoveryTemplate = await readFile(fixture.template, "utf8");
      }
      return ok();
    };
    const subject = createUpdaterApp(
      { ...fixture.config, mode: "standalone" },
      { run, fetch: fixture.fetch },
    );
    expect(
      (
        await request(subject, "/deploy", {
          revision: targetCommit,
          idempotencyKey: "failure-operation-0001",
          channel: "stable",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect((await new DeploymentJournal(fixture.deployDir).read())?.state).toBe("failed"),
    );
    expect(recreates).toBe(2);
    expect(recoveryTemplate).toBe(fixture.before);
    expect(await readFile(fixture.template, "utf8")).toBe(fixture.before);
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "ORKBOT_IMAGE_TAG=v1.0.0",
    );
  });
  it("refuses a release whose image does not match the revision image", async () => {
    const { config, deployDir } = await deployment();
    const instance = createUpdaterApp(
      { ...config, mode: "standalone" },
      {
        run: async (command) =>
          command === "docker" ? ok("a".repeat(40)) : ok(`${targetCommit}\trefs/tags/v1.2.3\n`),
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("/releases?"))
            return Response.json([{ tag_name: "v1.2.3", draft: false, prerelease: false }]);
          if (url.includes("/compare/")) return Response.json({ status: "ahead" });
          if (url.includes("/token?")) return Response.json({ token: "fixture-token" });
          if (url.includes("/manifests/"))
            return new Response(null, {
              headers: {
                "content-type": "application/vnd.oci.image.index.v1+json",
                "docker-content-digest": `sha256:${url.endsWith("v1.2.3") ? "c".repeat(64) : "b".repeat(64)}`,
              },
            });
          throw new Error("Unexpected URL");
        },
      },
    );
    const response = await request(instance, "/deploy", {
      revision: targetCommit,
      idempotencyKey: "digest-mismatch-0001",
      channel: "stable",
    });
    expect(response.status).toBe(400);
    expect(await new DeploymentJournal(deployDir).read()).toBeNull();
  });
  it("does not replay an acknowledged operation after restarting the updater", async () => {
    const { config, deployDir } = await deployment();
    const operation = {
      revision: targetCommit,
      idempotencyKey: "operation-restart-0001",
      state: "running" as const,
    };
    await new DeploymentJournal(deployDir).write(operation);
    let commands = 0;
    const restarted = createUpdaterApp(
      { ...config, mode: "standalone" },
      {
        run: async () => {
          commands++;
          return ok();
        },
      },
    );
    const response = await request(restarted, "/deploy", { ...operation, channel: "stable" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(operation);
    expect(commands).toBe(0);
    const other = await request(restarted, "/deploy", {
      ...operation,
      idempotencyKey: "different-operation-0001",
      channel: "stable",
    });
    expect(other.status).toBe(400);
    expect(commands).toBe(0);
  });

  it("refuses prereleases in the stable channel before executing host commands", async () => {
    const { config } = await deployment();
    let commands = 0;
    const instance = createUpdaterApp(
      { ...config, mode: "standalone" },
      {
        run: async () => {
          commands++;
          return ok();
        },
        fetch: async () =>
          Response.json([{ tag_name: "v1.0.0-beta.1", draft: false, prerelease: true }]),
      },
    );
    const response = await request(instance, "/deploy", {
      revision: targetCommit,
      idempotencyKey: "stable-operation-0001",
      channel: "stable",
    });
    expect(response.status).toBe(400);
    expect(commands).toBe(0);
  });
});

describe("updater orchestration", () => {
  it("serializes updates before their asynchronous preflight can race", async () => {
    const fixture = await deployment();
    let releaseGate: ((result: ReturnType<typeof ok>) => void) | undefined;
    const pendingRelease = new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseGate = resolve;
    });
    let reachedRemote!: () => void;
    const atRemote = new Promise<void>((resolve) => {
      reachedRemote = resolve;
    });
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git" && args.includes("ls-remote")) {
        reachedRemote();
        return pendingRelease;
      }
      return ok();
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const input = { repoUrl: "https://github.com/orkbot-run/ork", branch: "main" };
    const first = request(subject, "/apply", input);
    await atRemote;
    const second = await request(subject, "/apply", input);
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toEqual({ error: "An update is already running." });
    releaseGate?.(ok(`${targetCommit}\trefs/tags/v1.1.0\n`));
    expect((await first).status).toBe(200);
  });

  it("restores the previous remote when a fork update fails after repointing it", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const previousRemote = "https://github.com/example/previous-fork";
    const nextRemote = "https://github.com/example/next-fork";
    const run: UpdaterCommandRunner = async (command, args) => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok(previousRemote);
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "fetch") return failed("registry unavailable");
      return ok();
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", { repoUrl: nextRemote, branch: "main" });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual(["remote", "fetch", "restore-remote"]);
    expect(
      calls.filter(({ args }) => args.slice(0, 3).join(" ") === "remote set-url origin"),
    ).toEqual([
      { command: "git", args: ["remote", "set-url", "origin", nextRemote] },
      { command: "git", args: ["remote", "set-url", "origin", previousRemote] },
    ]);
  });

  it("restores the prior image after a recreate fails health checks", async () => {
    const fixture = await deployment();
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    let upCalls = 0;
    const run: UpdaterCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
      if (args.includes("pull")) return ok("pulled");
      upCalls += 1;
      return upCalls === 1 ? failed("api did not become healthy") : ok("restored");
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", {
      repoUrl: "https://github.com/orkbot-run/ork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record).toMatchObject({ ok: false, restart: "not-required" });
    expect(record.steps.map((step) => step.id)).toEqual(["pull", "recreate", "recover"]);
    expect(record.restartAdvice).toMatch(/restored the previously running v1\.0\.0 image/);
    const composeUp = calls.filter(({ args }) => args.includes("up"));
    expect(composeUp).toHaveLength(2);
    expect(composeUp[0]?.args).toEqual(expect.arrayContaining(["--wait", "--pull", "never"]));
    expect(composeUp[0]?.args).toContain("--no-build");
    expect(composeUp[1]?.args).toContain("--no-build");
    expect(composeUp[0]?.env?.ORKBOT_IMAGE_TAG).toBe(`sha-${targetCommit}`);
    expect(composeUp[1]?.env?.ORKBOT_IMAGE_TAG).toBe("v1.0.0");
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "ORKBOT_IMAGE_TAG=v1.0.0",
    );

    const state = await subject.request("/state", { method: "GET", headers: authorized });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      running: false,
      lastRun: { ok: false, fromTag: "v1.0.0", toTag: `sha-${targetCommit}` },
    });
  });

  it("keeps the original environment and reports manual recovery when both recreates fail", async () => {
    const original =
      "ORKBOT_IMAGE_TAG=v1.0.0\nORKBOT_IMAGE_TAG_PREVIOUS=v0.9.0\nPOSTGRES_APP_PASSWORD=synthetic-existing-password\nTEST_OPERATOR_SETTING=preserved\n";
    const fixture = await deployment(original);
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    const run: UpdaterCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
      return args.includes("pull") ? ok("pulled") : failed("Synthetic recreate failure");
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", {
      repoUrl: "https://github.com/orkbot-run/ork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record).toMatchObject({ ok: false, restart: "manual", fromTag: "v1.0.0" });
    expect(record.steps.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: "pull", ok: true },
      { id: "recreate", ok: false },
      { id: "recover", ok: false },
    ]);
    const recreates = calls.filter(({ args }) => args.includes("up"));
    expect(recreates).toHaveLength(2);
    expect(recreates[1]?.env?.ORKBOT_IMAGE_TAG).toBe("v1.0.0");
    expect(recreates[1]?.args).toEqual(
      expect.arrayContaining(["--pull", "never", "--no-build", "--wait"]),
    );
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toBe(original);
    const state = await subject.request("/state", { headers: authorized });
    expect(await state.json()).toMatchObject({
      running: false,
      lastRun: { ok: false, restart: "manual" },
    });
    expect(calls.filter(({ command }) => command === "docker")).toHaveLength(3);
  });

  it("resets a fork checkout when recreate fails after the fast-forward", async () => {
    const fixture = await deployment("ORKBOT_IMAGE_TAG=local\n");
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: string[][] = [];
    let upCalls = 0;
    const run: UpdaterCommandRunner = async (command, args) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") {
        // After the merge step the checkout is on the target; before that it is still current.
        const merged = calls.some((seen) => seen[0] === "merge");
        return ok(merged ? targetCommit : currentCommit);
      }
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (command === "docker" && args.includes("up")) {
        upCalls += 1;
        return upCalls === 1 ? failed("api did not become healthy") : ok("restored");
      }
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "recreate",
      "restore-checkout",
      "recover",
    ]);
    expect(calls).toContainEqual(["checkout", "-B", "main", currentCommit]);
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "ORKBOT_IMAGE_TAG=local",
    );
  });

  it("restores the prior branch when merge fails after checkout switches", async () => {
    const fixture = await deployment("ORKBOT_IMAGE_TAG=local\n");
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("deploy");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "merge") return failed("not a fast-forward");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "restore-checkout",
    ]);
    expect(calls).toContainEqual(["checkout", "-B", "deploy", currentCommit]);
  });

  it("rolls back from the cached image without trusting the registry tag again", async () => {
    const fixture = await deployment();
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/rollback");
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(true);
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(calls.find((args) => args.includes("up"))).toEqual(
      expect.arrayContaining(["--pull", "never"]),
    );
  });

  it("preserves the environment owner and surrounding values with mode 0600", async () => {
    const fixture = await deployment("FAKE_SETTING=kept\nORKBOT_IMAGE_TAG=v1.0.0\n");
    const envFile = path.join(fixture.deployDir, ".env");
    await chmod(envFile, 0o644);
    const before = await lstat(envFile);
    const run: UpdaterCommandRunner = async (command) =>
      command === "git" ? ok(`${targetCommit}\trefs/tags/v1.1.0\n`) : ok();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/orkbot-run/ork",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const after = await lstat(envFile);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode & 0o777 }).toEqual({
      uid: before.uid,
      gid: before.gid,
      mode: 0o600,
    });
    expect(await readFile(envFile, "utf8")).toMatch(/FAKE_SETTING=kept/);
  });

  it("adds a missing app database password before recreating, so newer Compose files start", async () => {
    const fixture = await deployment("POSTGRES_PASSWORD=kept\nORKBOT_IMAGE_TAG=v1.0.0\n");
    const envFile = path.join(fixture.deployDir, ".env");
    let envAtRecreate = "";
    const run: UpdaterCommandRunner = async (command, args) => {
      if (command === "git") return ok(`${targetCommit}\trefs/tags/v1.1.0\n`);
      if (args.includes("up")) envAtRecreate = await readFile(envFile, "utf8");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/orkbot-run/ork",
      branch: "main",
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(envAtRecreate).toMatch(/^POSTGRES_APP_PASSWORD=[0-9a-f]{32}$/m);
    expect(envAtRecreate).toMatch(/^POSTGRES_PASSWORD=kept$/m);
  });

  it("refuses to replace a symlinked deployment environment", async () => {
    const fixture = await deployment();
    const envFile = path.join(fixture.deployDir, ".env");
    const target = path.join(fixture.deployDir, "fake-target");
    await writeFile(target, "ORKBOT_IMAGE_TAG=v1.0.0\n");
    await rm(envFile);
    await symlink(target, envFile);
    const run: UpdaterCommandRunner = async (command) =>
      command === "git" ? ok(`${targetCommit}\trefs/tags/v1.1.0\n`) : ok();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/orkbot-run/ork",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/persist/),
    });
    expect(await readFile(target, "utf8")).toBe("ORKBOT_IMAGE_TAG=v1.0.0\n");
  });

  it("fails closed when it cannot verify checkout cleanliness", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const run: UpdaterCommandRunner = async (_command, args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status")) return failed("cannot read index");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/verified/),
    });
  });
});

describe("child process environment", () => {
  it("declares the deployment directory safe so git works on a non-root checkout", () => {
    // The child environment is rebuilt from an allowlist, so GIT_CONFIG_* set on the Compose
    // service never reaches git. Without these three, every git call exits 128 with "detected
    // dubious ownership" on the layout docs/self-host-production.md recommends.
    const env = commandEnvironment({ ORKBOT_DEPLOY_DIR: "/srv/orkbot" });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/srv/orkbot");
  });

  it("keeps the exemption scoped to the deployment directory, whoever calls it", () => {
    const env = commandEnvironment(
      { ORKBOT_DEPLOY_DIR: "/opt/orkbot" },
      { GIT_CONFIG_VALUE_0: "*", GIT_CONFIG_COUNT: "9" },
    );
    expect(env.GIT_CONFIG_VALUE_0).toBe("/opt/orkbot");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });

  it("sets no git ownership exemption when no deployment directory is known", () => {
    const env = commandEnvironment({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("passes operational settings and explicit overrides without leaking application secrets", () => {
    const env = commandEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.invalid",
        BETTER_AUTH_SECRET: "fake-secret-that-must-not-leak",
        DATABASE_URL: "postgres://fake.invalid/db",
        AXIOM_TOKEN: "fake-axiom-token",
        LOG_LEVEL: "debug",
      },
      { ORKBOT_IMAGE_TAG: "sha-123" },
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.invalid",
      ORKBOT_IMAGE_TAG: "sha-123",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AXIOM_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
  });

  it("restores detached checkouts without attaching to a branch tip", () => {
    expect(restoreCheckoutArgv("HEAD", currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv(null, currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv("deploy", currentCommit)).toEqual([
      "checkout",
      "-B",
      "deploy",
      currentCommit,
    ]);
  });
});

describe("runHostCommand", () => {
  it("passes shell syntax to git as one argument and refuses any other program", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "orkbot-host-command-"));
    temporaryDirectories.push(dir);
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const out = path.join(dir, "argv.json");
    const git = path.join(bin, "git");
    await writeFile(
      git,
      `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(git, 0o755);
    const payload = "a; touch pwned $(id)";
    const result = await runHostCommand("git", ["status", payload], {
      cwd: dir,
      timeoutMs: 5_000,
      env: { PATH: bin, ARGV_OUT: out },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual(["status", payload]);

    const marker = path.join(dir, "pwned");
    const bash = path.join(bin, "bash");
    await writeFile(
      bash,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    );
    await chmod(bash, 0o755);
    const refused = await runHostCommand("bash", ["-c", payload], {
      cwd: dir,
      timeoutMs: 1_000,
      env: { PATH: bin },
    });
    expect(refused).toEqual({
      ok: false,
      exitCode: null,
      stdout: "",
      output: "Refusing to run an unexpected program.",
    });
    await expect(readFile(marker, "utf8")).rejects.toThrow();

    const nul = await runHostCommand("docker", ["a\0b"], { cwd: dir, timeoutMs: 1_000 });
    expect(nul).toEqual({
      ok: false,
      exitCode: null,
      stdout: "",
      output: "Refusing to run an unexpected program.",
    });
  });
});
