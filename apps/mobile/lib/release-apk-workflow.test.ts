import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Validate the active workflow definition.
const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-android-apk.yml"),
  "utf8",
);
const easConfig = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../eas.json"), "utf8"),
) as { build: Record<string, { extends?: string; android?: { buildType?: string } }> };

function workflowJob(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Workflow job ${name} is missing.`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:$/.test(lines[end] ?? "")) end += 1;
  return lines.slice(start, end).join("\n");
}

describe("Android APK release workflow", () => {
  it("supports on-demand and reusable workflows with diagnostic defaults", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).toMatch(/^ {2}workflow_call:/m);
    const triggers = workflow.split("\npermissions:")[0];
    expect(triggers?.match(/default: diagnostic/g)).toHaveLength(2);
    expect(triggers).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("cache: pnpm");
  });

  it("keeps diagnostic APKs in read-only Actions artifacts without production publication", () => {
    const diagnostic = workflowJob("diagnostic");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(diagnostic).toContain("if: needs.configuration.outputs.mode == 'diagnostic'");
    expect(diagnostic).not.toContain("contents: write");
    expect(diagnostic).not.toContain("secrets.");
    expect(diagnostic).not.toMatch(/gh release|eas build|expo-github-action/);
    expect(diagnostic).toContain("expo prebuild --platform android --no-install");
    expect(diagnostic).toContain("bash .github/scripts/prepare-android-gradle.sh");
    expect(diagnostic).toContain("build-android-diagnostic.sh");
    const script = readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/scripts/build-android-diagnostic.sh"),
      "utf8",
    );
    expect(script).toContain("app:assembleRelease -PreactNativeArchitectures=arm64-v8a");
    expect(diagnostic).toContain("actions/upload-artifact@");
    expect(diagnostic).toContain("outputs/apk/release/app-release.apk");
  });

  it.each([
    { mirrorFails: false, fallbackFails: false, expectedCalls: 1, succeeds: true },
    { mirrorFails: true, fallbackFails: false, expectedCalls: 2, succeeds: true },
    { mirrorFails: true, fallbackFails: true, expectedCalls: 2, succeeds: false },
  ])("retries with the original repositories only after a mirror build failure: %j", (scenario) => {
    const root = mkdtempSync(path.join(tmpdir(), "ork-android-mirror-"));
    try {
      const fake = path.join(root, "gradlew");
      const log = path.join(root, "calls");
      writeFileSync(
        fake,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_CALLS"
if [[ "$*" == *--init-script* ]]; then exit "$TEST_MIRROR_FAIL"; fi
exit "$TEST_FALLBACK_FAIL"
`,
      );
      chmodSync(fake, 0o755);
      const result = spawnSync(
        "bash",
        [
          path.resolve(import.meta.dirname, "../../../.github/scripts/build-android-diagnostic.sh"),
          fake,
          "/tmp/mirror.init.gradle",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            TEST_CALLS: log,
            TEST_MIRROR_FAIL: scenario.mirrorFails ? "1" : "0",
            TEST_FALLBACK_FAIL: scenario.fallbackFails ? "1" : "0",
          },
        },
      );
      expect(result.status === 0).toBe(scenario.succeeds);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls).toHaveLength(scenario.expectedCalls);
      expect(calls[0]).toContain("--init-script /tmp/mirror.init.gradle");
      if (calls.length === 2) expect(calls[1]).not.toContain("--init-script");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["9.3.1", "8.14.3"])(
    "prepares the generated Gradle %s distribution offline",
    (version) => {
      const result = prepareGradle(version);
      try {
        expect(result.status, result.stderr).toBe(0);
        expect(result.properties).toContain("distributionUrl=file\\:///");
        expect(result.properties).toContain(`distributionSha256Sum=${result.checksum}`);
        expect(result.properties).toContain("networkTimeout=10000");
        expect(result.requests).toContain(`/releases/tags/v${version}`);
        expect(result.requests).toContain(`/distributions/gradle-${version}-bin.zip.sha256`);
      } finally {
        result.cleanup();
      }
    },
  );

  it("rejects a Gradle archive that fails its official checksum", () => {
    const result = prepareGradle("9.3.1", true);
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum does not match");
      expect(result.properties).toContain("distributionUrl=https\\://services.gradle.org/");
    } finally {
      result.cleanup();
    }
  });

  it("rejects an unexpected generated distribution before downloading anything", () => {
    const result = prepareGradle("9.3.1/../../unexpected");
    try {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("distribution URL is unsupported");
      expect(result.requests).toBe("");
    } finally {
      result.cleanup();
    }
  });

  it("requires explicit EAS mode and main before production publishing", () => {
    const release = workflowJob("release");
    expect(release).toContain("needs: configuration");
    expect(release).toContain(
      "if: github.ref == 'refs/heads/main' && needs.configuration.outputs.mode == 'eas'",
    );
    expect(release).toContain("contents: write");
    expect(release).toContain("gh release create");
    expect(release).toContain("--profile android-apk");
    const configuration = workflowJob("configuration");
    expect(configuration).toContain("EXPO_TOKEN EXPO_PROJECT_ID EXPO_OWNER EXPO_PUBLIC_API_URL");
    expect(configuration).toContain('echo "mode=$mode" >> "$GITHUB_OUTPUT"');
    expect(configuration).toMatch(/if \(\( \$\{#missing\[@\]\} \)\); then\n.*\n\s+exit 1/);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("builds a production-channel APK and never takes the desktop updater's latest release", () => {
    expect(easConfig.build["android-apk"]).toEqual({
      extends: "production",
      android: { buildType: "apk" },
      environment: "production",
    });
    expect(workflow).toContain("--profile android-apk");
    expect(workflow).toContain("--latest=false");
    expect(workflow).not.toContain("gh release delete");
    expect(readFileSync(path.resolve(import.meta.dirname, "../app.config.ts"), "utf8")).toContain(
      '"android-apk"',
    );
  });
});

function prepareGradle(version: string, badChecksum = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ork-gradle-test-"));
  const bin = path.join(root, "bin");
  const wrapper = path.join(root, "gradle-wrapper.properties");
  const requests = path.join(root, "requests");
  const archive = "offline fake archive";
  const checksum = createHash("sha256").update(archive).digest("hex");
  mkdirSync(bin);
  const fakeCurl = path.join(bin, "curl");
  writeFileSync(
    fakeCurl,
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$TEST_REQUESTS"
case "$url" in
  */releases/tags/*) printf '{"assets":[{"name":"gradle-%s-bin.zip","state":"uploaded","url":"https://api.github.com/repos/gradle/gradle-distributions/releases/assets/123"}]}' "$TEST_VERSION" > "$output" ;;
  */releases/assets/123) printf '%s' "$TEST_ARCHIVE" > "$output" ;;
  *.sha256) printf '%s' "$TEST_CHECKSUM" > "$output" ;;
  *) exit 22 ;;
esac
`,
  );
  chmodSync(fakeCurl, 0o755);
  writeFileSync(
    wrapper,
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\nnetworkTimeout=10000\n`,
  );
  const run = spawnSync(
    "bash",
    [
      path.resolve(import.meta.dirname, "../../../.github/scripts/prepare-android-gradle.sh"),
      wrapper,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        TEST_REQUESTS: requests,
        TEST_VERSION: version,
        TEST_ARCHIVE: archive,
        TEST_CHECKSUM: badChecksum ? "0".repeat(64) : checksum,
      },
    },
  );
  return {
    status: run.status,
    stderr: run.stderr,
    checksum,
    properties: readFileSync(wrapper, "utf8"),
    requests: existsSync(requests) ? readFileSync(requests, "utf8") : "",
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
