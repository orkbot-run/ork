import { readFileSync } from "node:fs";
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
    expect(diagnostic).toContain("app:assembleRelease -PreactNativeArchitectures=arm64-v8a");
    expect(diagnostic).toContain("actions/upload-artifact@");
    expect(diagnostic).toContain("outputs/apk/release/app-release.apk");
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
