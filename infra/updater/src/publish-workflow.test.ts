// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify narrowed CI triggers. See LICENSE.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validate the active workflow definitions.
const workflowsDir = path.resolve(import.meta.dirname, "../../../.github/workflows");
const workflowText = readFileSync(path.join(workflowsDir, "publish-server-image.yml"), "utf8");
const publisherDir = path.resolve(workflowsDir, "../actions/publish-image");
const publisherText = readFileSync(path.join(publisherDir, "action.yml"), "utf8");
interface WorkflowStep {
  id?: string;
  if?: string;
  uses?: string;
  "continue-on-error"?: boolean;
  run?: string;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  uses?: string;
  "runs-on"?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { arch?: string[]; include?: Array<Record<string, string>> } };
  steps: WorkflowStep[];
  concurrency?: { group: string; queue?: string; "cancel-in-progress": boolean };
}

const workflow = parse(workflowText) as {
  concurrency: { group: string; "cancel-in-progress": string };
  on: Record<string, { branches?: string[]; tags?: string[]; paths?: string[] } | null>;
  jobs: {
    validate: WorkflowJob;
    build: WorkflowJob;
    "build-depot": WorkflowJob;
    publish: WorkflowJob;
  };
};
const ci = parse(readFileSync(path.join(workflowsDir, "ci.yml"), "utf8")) as {
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, WorkflowJob>;
};
const publisher = parse(publisherText) as { runs: { steps: WorkflowStep[] } };
const publicationAction = "./.github/actions/publish-image";

describe("server image publish workflow", () => {
  it("builds every architecture natively instead of emulating arm64", () => {
    expect(workflowText).not.toContain("setup-qemu-action");
    const build = workflow.jobs.build;
    expect(build["runs-on"]).toContain("matrix.runner");
    expect(build.strategy?.matrix?.arch).toEqual(["amd64", "arm64"]);
    const runners = Object.fromEntries(
      (build.strategy?.matrix?.include ?? [])
        .filter((entry) => entry.arch !== undefined)
        .map((entry) => [entry.arch, entry.runner]),
    );
    expect(runners).toEqual({ amd64: "ubuntu-latest", arm64: "ubuntu-24.04-arm" });
  });

  it("publishes Depot images in their build job and combines native architecture builds separately", () => {
    const depot = workflow.jobs["build-depot"];
    expect(depot.steps.some((step) => step.uses === publicationAction)).toBe(true);
    expect(depot.steps.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(
      false,
    );
    expect(depot.permissions?.attestations).toBe("write");
    const publish = workflow.jobs.publish;
    expect(publish.needs).toEqual(["build"]);
    expect(publish.if).toContain("needs.build.result == 'success'");
    expect(publish.steps.some((step) => step.uses === publicationAction)).toBe(true);
    expect(publish.permissions?.attestations).toBe("write");
    expect(workflowText).toContain("push-by-digest=true");
    const manifest = publisher.runs.steps.findIndex((step) =>
      step.run?.includes('"$ACTION_PATH/publish.sh"'),
    );
    const attest = publisher.runs.steps.findIndex((step) =>
      step.uses?.startsWith("actions/attest-build-provenance@"),
    );
    expect(manifest).toBeGreaterThanOrEqual(0);
    expect(attest).toBeGreaterThan(manifest);
  });

  it("builds on Depot only when the repository names a project, and never for pull requests", () => {
    const depot = workflow.jobs["build-depot"];
    expect(depot.if).toBe("github.event_name != 'pull_request' && vars.DEPOT_PROJECT_ID != ''");
    expect(workflow.jobs.build.if).toContain("github.event_name != 'pull_request'");
    expect(workflow.jobs.build.if).toContain("vars.DEPOT_PROJECT_ID == ''");
    expect(depot.permissions?.["id-token"]).toBe("write");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal workflow expression
    expect(workflowText).toContain("project: ${{ vars.DEPOT_PROJECT_ID }}");
  });

  it("rebuilds on GitHub's runners when a Depot build fails", () => {
    const depot = workflow.jobs["build-depot"];
    const build = depot.steps.find((step) => step.uses?.startsWith("depot/build-push-action@"));
    expect(build?.id).toBe("build");
    expect(build?.["continue-on-error"]).toBe(true);
    // Every step after the Depot build either reports its outcome or runs only on success.
    const after = depot.steps.slice(depot.steps.indexOf(build as WorkflowStep) + 1);
    for (const step of after.filter((step) => step.id !== "depot")) {
      expect(step.if).toContain("steps.build.outcome == 'success'");
    }
    expect(Object.keys(depot.outputs ?? {}).sort()).toEqual(["app", "computer", "updater"]);
    const fallback = workflow.jobs.build;
    expect(fallback.needs).toEqual(["build-depot"]);
    expect(fallback.if).toContain("!cancelled()");
    expect(fallback.if).toContain("needs.build-depot.result == 'failure'");
    for (const image of ["app", "updater", "computer"]) {
      expect(fallback.if).toContain(`needs.build-depot.outputs.${image} == 'failed'`);
    }
  });

  it("checks credentials before publishing Depot tags or making native digests available", () => {
    const nativeSteps = workflow.jobs.build.steps;
    const nativeScan = nativeSteps.findIndex((step) =>
      step.run?.includes("check-image.sh /tmp/rootfs.tar"),
    );
    const upload = nativeSteps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(nativeScan).toBeGreaterThanOrEqual(0);
    const nativeBuild = nativeSteps.find((step) => step.id === "build");
    expect(nativeBuild?.with?.outputs).toContain("type=tar,dest=/tmp/rootfs.tar");
    expect(upload).toBeGreaterThan(nativeScan);
    const depotSteps = workflow.jobs["build-depot"].steps;
    const depotScan = depotSteps.findIndex((step) => step.run?.includes("check-image.sh"));
    const publish = depotSteps.findIndex((step) => step.uses === publicationAction);
    expect(depotScan).toBeGreaterThanOrEqual(0);
    expect(depotSteps[depotScan]?.run).toContain("for platform in linux/amd64 linux/arm64; do");
    expect(publish).toBeGreaterThan(depotScan);
  });

  it("publishes main from ci.yml so the production deploy waits for its image", () => {
    expect(workflow.on.push?.branches).toBeUndefined();
    expect(workflow.on).toHaveProperty("workflow_call");
    const publish = ci.jobs["publish-server-image"];
    expect(publish?.uses).toBe("./.github/workflows/publish-server-image.yml");
    expect(publish?.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(ci.jobs["deploy-production"]?.needs).toEqual([
      "checks",
      "test-integration",
      "publish-server-image",
    ]);
  });

  it("cancels superseded main checks while keeping release publication locks", () => {
    for (const concurrency of [ci.concurrency, workflow.concurrency]) {
      expect(concurrency.group).toContain("github.run_id");
      expect(concurrency.group).toContain("github.event.pull_request.number");
    }
    expect(ci.concurrency.group).toContain("github.event_name == 'push'");
    expect(ci.concurrency.group).toContain("github.ref == 'refs/heads/main' && 'main'");
    expect(ci.concurrency["cancel-in-progress"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      "${{ github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main') }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      "${{ github.event_name == 'pull_request' }}",
    );
    for (const job of [
      ci.jobs["deploy-production"],
      ci.jobs["publish-mobile-update"],
      workflow.jobs["build-depot"],
      workflow.jobs.publish,
    ]) {
      expect(job?.concurrency?.queue).toBe("max");
      expect(job?.concurrency?.["cancel-in-progress"]).toBe(false);
    }
  });

  it("keeps distinct job locks and starts release prerequisites without extra dependencies", () => {
    const locks = [
      "static-checks",
      "unit-tests-shard",
      "test-integration-shard",
      "publish-server-image",
    ].map((name) => ci.jobs[name]?.concurrency);
    expect(new Set(locks.map((lock) => lock?.group)).size).toBe(locks.length);
    for (const lock of locks) {
      expect(lock?.group).toMatch(/main/);
      expect(lock?.queue).toBeUndefined();
      expect(lock?.["cancel-in-progress"]).toBeUndefined();
    }
    // Release prerequisites start with the run instead of waiting for the path-classification job.
    for (const name of [
      "static-checks",
      "unit-tests-shard",
      "test-integration-shard",
      "publish-server-image",
    ]) {
      expect(ci.jobs[name]?.needs, name).toBeUndefined();
    }
  });

  it("limits image validation to server and web build manifests", () => {
    const paths = workflow.on.pull_request?.paths ?? [];
    expect(paths).not.toContain("**/package.json");
    for (const manifest of [
      "package.json",
      "apps/api/package.json",
      "apps/worker/package.json",
      "apps/web/package.json",
      "packages/adapters/package.json",
      "packages/contracts/package.json",
      "packages/ui-web/package.json",
      "packages/chat-ui/package.json",
    ]) {
      expect(paths, manifest).toContain(manifest);
    }
    for (const app of ["accounts-web", "desktop", "mobile", "www"]) {
      expect(paths).not.toContain(`apps/${app}/package.json`);
    }
    expect(paths).not.toContain("packages/testkit/package.json");
    expect(paths).toContain("pnpm-lock.yaml");
  });

  it("rebuilds Tauri for every desktop path and external bundle resource", () => {
    const tauri = parse(readFileSync(path.join(workflowsDir, "desktop-tauri.yml"), "utf8")) as {
      on: Record<"push" | "pull_request", { paths: string[] }>;
    };
    const paths = tauri.on.pull_request.paths;
    expect(paths).toContain("apps/desktop/**");
    expect(tauri.on.push.paths).toEqual(paths);
    const desktop = path.join(workflowsDir, "../../apps/desktop/src-tauri");
    const config = JSON.parse(readFileSync(path.join(desktop, "tauri.conf.json"), "utf8")) as {
      bundle: { resources: Record<string, string> };
    };
    for (const resource of Object.keys(config.bundle.resources)) {
      const source = path.relative(
        path.join(workflowsDir, "../.."),
        path.resolve(desktop, resource),
      );
      expect(
        paths.some(
          (pattern) =>
            pattern === source ||
            (pattern.endsWith("/**") && source.startsWith(pattern.slice(0, -2))),
        ),
        source,
      ).toBe(true);
    }
  });

  it("runs native adapter checks only for native changes and lints every main push", () => {
    expect(ci.jobs["native-computer"]?.if).toBe("needs.changes.outputs.native == 'true'");
    const nativeSteps = ci.jobs["native-computer"]?.steps ?? [];
    expect(nativeSteps.some((step) => step.run?.includes("host-computer.test.ts"))).toBe(true);
    expect(nativeSteps.some((step) => step.run?.includes("apps/desktop"))).toBe(false);
    for (const name of ["Lint", "Check translation catalogs are current"]) {
      const step = ci.jobs["static-checks"]?.steps.find(
        (step) => (step as { name?: string }).name === name,
      );
      expect(step, name).toBeDefined();
      expect(step?.if).toBeUndefined();
    }
  });

  it("keeps pull requests read-only and every action pinned to a commit", () => {
    const validate = workflow.jobs.validate;
    expect(validate.if).toBe("github.event_name == 'pull_request'");
    expect(validate.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish.if).toContain("github.event_name != 'pull_request'");
    const build = validate.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(build?.with?.push).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions cache scope
    const cacheScope = "scope=pr-${{ github.event.pull_request.number }}-${{ matrix.name }}";
    expect(build?.with?.["cache-from"]).toContain(cacheScope);
    expect(build?.with?.["cache-to"]).toContain(cacheScope);
    for (const text of [workflowText, publisherText]) {
      for (const match of text.matchAll(/uses:\s+([^\s#]+)/g)) {
        if (match[1] === publicationAction) continue;
        expect(match[1], match[1]).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});
