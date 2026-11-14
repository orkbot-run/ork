import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
    expect(workflow).toMatch(/^on:/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:/m);
    expect(workflow).toMatch(/^ {2}workflow_call:/m);
    const triggers = workflow.split("\npermissions:")[0];
    expect(triggers?.match(/default: diagnostic/g)).toHaveLength(2);
    expect(triggers).toContain("push:\n    branches: [main]");
    expect(triggers).toContain("pull_request:\n    paths: *android_build_paths");
    for (const source of [
      "apps/mobile/**",
      "packages/chat-ui/**",
      "packages/client-transport/**",
      "packages/contracts/**",
      "packages/core/**",
      "packages/logging/**",
      "packages/ui-tokens/**",
      "packages/ui-web/**",
      "pnpm-lock.yaml",
    ])
      expect(triggers).toContain(source);
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
    expect(script).toContain("app:assembleRelease :orkbot-notifications:testDebugUnitTest");
    expect(script).toContain("-PreactNativeArchitectures=arm64-v8a");
    expect(diagnostic).toContain("actions/upload-artifact@");
    expect(diagnostic).toContain("outputs/apk/release/app-release.apk");
    expect(diagnostic).toContain("verify-android-apk.sh");
    expect(workflowJob("configuration")).not.toContain("secrets.");
  });

  it("rebuilds Android when any resolved mobile workspace changes", () => {
    const repository = path.resolve(import.meta.dirname, "../../..");
    const workspaces = new Map<string, string>();
    for (const entry of readdirSync(path.join(repository, "packages"))) {
      const directory = `packages/${entry}`;
      const manifest = path.join(repository, directory, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      workspaces.set(name, directory);
    }
    // Leaf workspaces can be absent from pnpm's importer list, so read the declared runtime graph.
    const dependencies = new Set<string>();
    function visit(directory: string) {
      if (dependencies.has(directory)) return;
      dependencies.add(directory);
      const manifest = JSON.parse(
        readFileSync(path.join(repository, directory, "package.json"), "utf8"),
      );
      for (const [name, version] of Object.entries({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) {
        if (typeof version !== "string" || !version.startsWith("workspace:")) continue;
        const target = workspaces.get(name);
        if (!target) throw new Error(`Unknown workspace dependency: ${name}`);
        visit(target);
      }
    }
    visit("apps/mobile");
    expect(dependencies.has("packages/avatar")).toBe(true);
    const triggers = workflow.split("\npermissions:")[0];
    for (const dependency of dependencies) expect(triggers).toContain(`- ${dependency}/**`);
  });

  it("keeps standalone and caller builds in separate queues while serializing one workflow and ref", () => {
    const group = workflow.match(/^ {2}group: (.+)$/m)?.[1];
    expect(group).toBeDefined();
    const ownName = workflow.match(/^name: (.+)$/m)?.[1];
    const callerName = readFileSync(
      path.resolve(import.meta.dirname, "../../../.github/workflows/release-mobile.yml"),
      "utf8",
    ).match(/^name: (.+)$/m)?.[1];
    expect(ownName).toBeDefined();
    expect(callerName).toBeDefined();
    function key(name: string, ref: string, pullRequest?: number, event = "push") {
      return group!.replace(/\$\{\{([^}]+)\}\}/g, (_, expression: string) => {
        switch (expression.trim()) {
          case "github.workflow":
            return name;
          case "github.event_name":
            return event;
          case "github.event.pull_request.number || github.ref":
            return String(pullRequest ?? ref);
          default:
            throw new Error(`Unexpected concurrency expression: ${expression}`);
        }
      });
    }
    const main = "refs/heads/main";
    expect(key(ownName!, main)).not.toBe(key(callerName!, main));
    expect(key(ownName!, main, undefined, "push")).toBe(
      key(ownName!, main, undefined, "workflow_dispatch"),
    );
    expect(key(ownName!, main)).not.toBe(key(ownName!, "refs/heads/feature"));
    expect(key(ownName!, "refs/pull/12/merge", 12)).not.toBe(
      key(ownName!, "refs/pull/13/merge", 13),
    );
    expect(workflow).toMatch(
      /^ {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
    );
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

  it.each([
    { fault: "none", succeeds: true },
    { fault: "modified-utf8", succeeds: true },
    { fault: "signature", succeeds: false },
    { fault: "package", succeeds: false },
    { fault: "missing-library", succeeds: false },
    { fault: "invalid-library", succeeds: false },
    { fault: "renamed-binding", succeeds: false },
    { fault: "corrupt-archive", succeeds: false },
    { fault: "missing-dex", succeeds: false },
    { fault: "mismatched-jni-name", succeeds: false },
    { fault: "mismatched-jni-signature", succeeds: false },
    { fault: "static-jni-method", succeeds: false },
    { fault: "missing-jni-export", succeeds: false },
    { fault: "missing-jni-tool", succeeds: false },
    { fault: "foreign-jni-method", succeeds: false },
  ])("qualifies the APK and rejects broken native packaging: $fault", ({ fault, succeeds }) => {
    const root = mkdtempSync(path.join(tmpdir(), "ork-apk-verification-"));
    try {
      const payload = path.join(root, "payload");
      const libraries = path.join(payload, "lib/arm64-v8a");
      const tools = path.join(root, "sdk/build-tools/36.0.0");
      const ndk = path.join(root, "sdk/ndk/27.1");
      const nativeTools = path.join(ndk, "toolchains/llvm/prebuilt/fixture/bin");
      mkdirSync(libraries, { recursive: true });
      mkdirSync(tools, { recursive: true });
      mkdirSync(nativeTools, { recursive: true });
      if (fault !== "missing-dex") {
        writeFileSync(path.join(payload, "classes.dex"), "synthetic dex fixture");
      }
      for (const name of ["libork_installation_transport.so", "libjnidispatch.so"]) {
        if (fault === "missing-library" && name === "libjnidispatch.so") continue;
        writeFileSync(
          path.join(libraries, name),
          fault === "invalid-library" ? "invalid" : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        );
      }
      const apk = path.join(root, "fixture.apk");
      execFileSync("zip", ["-qr", apk, "."], { cwd: payload });
      if (fault === "corrupt-archive") writeFileSync(apk, "invalid archive");
      // SDK command boundaries are faked here; the workflow runs real Android tools on the built APK.
      const commands = {
        apksigner: `exit ${fault === "signature" ? 1 : 0}`,
        aapt2: `echo "package: name='${fault === "package" ? "example.wrong" : "run.orkbot.app"}' versionCode='1'"`,
        dexdump: `${fault === "modified-utf8" ? "printf '\\300\\200fixture\\n'" : ""}
cat <<'DEX'
Class descriptor  : 'Lcom/sun/jna/${fault === "renamed-binding" ? "Renamed" : "Native"};'
Class descriptor  : 'Luniffi/ork_installation_transport/UniffiLib;'
Class descriptor  : 'Lorg/rustls/platformverifier/CertificateVerifier;'
Class descriptor  : 'Lcom/orkbot/transport/OrkTransportModule;'
${fault === "foreign-jni-method" ? "Class descriptor  : 'Lexample/Other;'" : ""}
      name          : '${fault === "mismatched-jni-name" ? "init_platform_verifier" : "initPlatformVerifier"}'
      type          : '${fault === "mismatched-jni-signature" ? "()V" : "(Landroid/content/Context;)V"}'
      access        : 0x0112 (PRIVATE FINAL ${fault === "static-jni-method" ? "STATIC " : ""}NATIVE)
DEX`,
      };
      for (const [name, body] of Object.entries(commands)) {
        const file = path.join(tools, name);
        writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
        chmodSync(file, 0o755);
      }
      if (fault !== "missing-jni-tool") {
        const nm = path.join(nativeTools, "llvm-nm");
        writeFileSync(
          nm,
          `#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == -D && "$2" == --defined-only && "\${3##*/}" == libork_installation_transport.so ]]\nprintf '%s\\n' '00000000 T ${fault === "missing-jni-export" ? "unrelated_symbol" : "Java_com_orkbot_transport_OrkTransportModule_initPlatformVerifier"}'\n`,
        );
        chmodSync(nm, 0o755);
      }
      const result = spawnSync(
        "bash",
        [path.resolve(import.meta.dirname, "../../../.github/scripts/verify-android-apk.sh"), apk],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ANDROID_HOME: path.join(root, "sdk"),
            ANDROID_NDK_HOME: ndk,
            ...(fault === "modified-utf8" ? { LC_ALL: "en_US.UTF-8" } : {}),
          },
        },
      );
      expect(result.status === 0, result.stderr).toBe(succeeds);
      if (succeeds) expect(result.stdout).toContain("native bindings verified");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["9.3.1", false],
    ["9.3.1", true],
    ["8.14.3", false],
    ["8.14.3", true],
  ] as const)(
    "prepares Gradle %s offline with GitHub CLI failure set to %s",
    (version, ghFails) => {
      const result = prepareGradle(version, false, ghFails);
      try {
        expect(result.status, result.stderr).toBe(0);
        expect(result.properties).toContain("distributionUrl=file\\:///");
        expect(result.properties).toContain(`distributionSha256Sum=${result.checksum}`);
        expect(result.properties).toContain("networkTimeout=10000");
        expect(result.requests).toContain(`/releases/tags/v${version}`);
        expect(result.requests).toContain(`/distributions/gradle-${version}-bin.zip.sha256`);
        expect(result.requests).toContain("gh repos/gradle/gradle-distributions/releases/tags/");
        expect(result.requests.includes("curl https://api.github.com/")).toBe(ghFails);
      } finally {
        result.cleanup();
      }
    },
  );

  it.each([false, true])(
    "rejects a Gradle archive with a bad checksum when GitHub CLI fails: %s",
    (ghFails) => {
      const result = prepareGradle("9.3.1", true, ghFails);
      try {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("checksum does not match");
        expect(result.properties).toContain("distributionUrl=https\\://services.gradle.org/");
      } finally {
        result.cleanup();
      }
    },
  );

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
    expect(configuration).toContain("EXPO_PROJECT_ID EXPO_OWNER EXPO_PUBLIC_API_URL");
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

function prepareGradle(version: string, badChecksum = false, ghFails = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ork-gradle-test-"));
  const bin = path.join(root, "bin");
  const wrapper = path.join(root, "gradle-wrapper.properties");
  const requests = path.join(root, "requests");
  const archive = "offline fake archive";
  const checksum = createHash("sha256").update(archive).digest("hex");
  mkdirSync(bin);
  const fakeGh = path.join(bin, "gh");
  writeFileSync(
    fakeGh,
    `#!/bin/sh
set -eu
endpoint=""
for arg in "$@"; do
  case "$arg" in repos/gradle/gradle-distributions/*) endpoint=$arg ;; esac
done
printf 'gh %s\\n' "$endpoint" >> "$TEST_REQUESTS"
if [ "$TEST_GH_FAIL" = 1 ]; then exit 1; fi
case "$endpoint" in
  */releases/tags/*) printf '{"assets":[{"name":"gradle-%s-bin.zip","state":"uploaded","url":"https://api.github.com/repos/gradle/gradle-distributions/releases/assets/123"}]}' "$TEST_VERSION" ;;
  */releases/assets/123) printf '%s' "$TEST_ARCHIVE" ;;
  *) exit 22 ;;
esac
`,
  );
  chmodSync(fakeGh, 0o755);
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
printf 'curl %s\\n' "$url" >> "$TEST_REQUESTS"
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
        TEST_GH_FAIL: ghFails ? "1" : "0",
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
