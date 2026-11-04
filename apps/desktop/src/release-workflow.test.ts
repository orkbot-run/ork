import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Validate the active workflow definition.
const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);

const expression = (inner: string) => `\${{ ${inner} }}`;

interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  environment?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
}
const definition = parse(workflow) as {
  on: { workflow_dispatch: { inputs: { signed_release: { default: boolean } } } };
  permissions: Record<string, string>;
  jobs: Record<
    "configuration" | "diagnostic-build" | "validate" | "build" | "publish",
    WorkflowJob
  >;
};
const signedBuild = definition.jobs.build;
const signedBuildText = signedBuild.steps
  .map((step) => [step.uses, step.run].filter(Boolean).join("\n"))
  .join("\n");

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    const checkouts = Object.values(definition.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
  });

  it("defaults to diagnostic artifacts with updates off and no release publication", () => {
    expect(definition.on.workflow_dispatch.inputs.signed_release.default).toBe(false);
    const diagnostic = definition.jobs["diagnostic-build"];
    expect(diagnostic.needs).toBe("configuration");
    expect(diagnostic.if).toBe("needs.configuration.outputs.signed != 'true'");
    expect(diagnostic.env?.ORKBOT_ENABLE_AUTO_UPDATE).toBe("0");
    expect(diagnostic.env?.ORKBOT_LINUX_UPDATE_PUBLIC_KEY).toBe("");
    expect(diagnostic.permissions?.contents ?? definition.permissions.contents).toBe("read");
    const artifact = diagnostic.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(artifact).toBeDefined();
    expect(artifact?.with?.path).toContain("apps/desktop/out/*.AppImage");
    expect(artifact?.with?.path).not.toContain(".yml");
    expect(diagnostic.steps.map((step) => step.run ?? "").join("\n")).not.toMatch(
      /gh release|--publish always/,
    );
  });

  it("gates stable publication on explicit signed mode and completed signed builds", () => {
    const mode = definition.jobs.configuration.steps.find((step) => step.id === "mode");
    expect(mode?.env?.REQUESTED_SIGNED).toBe(expression("inputs.signed_release"));
    expect(mode?.env?.TAG_SIGNED_ENABLED).toBe(expression("vars.DESKTOP_SIGNED_RELEASE_ENABLED"));
    expect(definition.jobs.validate.needs).toBe("configuration");
    expect(definition.jobs.validate.if).toBe("needs.configuration.outputs.signed == 'true'");
    expect(signedBuild.needs).toBe("validate");
    expect(definition.jobs.publish.needs).toEqual(["validate", "build"]);
    expect(definition.jobs.publish.permissions?.contents).toBe("write");
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("requires signed platform builds before a single publication job", () => {
    expect(workflow).toContain('ORKBOT_DESKTOP_RELEASE: "1"');
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).not.toContain("DESKTOP_WIN_CSC");
    expect(workflow).not.toMatch(/secrets\.DESKTOP_CSC_(?:LINK|KEY_PASSWORD)/);
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).toContain("apps/desktop/out/latest*.yml");
    expect(workflow).not.toContain("apps/desktop/out/*.yml");
  });

  it("notarizes macOS with a short-lived App Store Connect API key file", () => {
    for (const secret of ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY_P8"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).not.toMatch(/secrets\.(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD)\b/);
    // The same temp path is declared by the setup, packaging, and cleanup steps.
    const keyFile = `APPLE_API_KEY: ${expression("runner.temp")}/apple-api-key.p8`;
    expect(workflow.split(keyFile)).toHaveLength(4);
    expect(workflow).toContain(`printf '%s\\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY"`);
    expect(workflow).toContain('chmod 600 "$APPLE_API_KEY"');
    expect(workflow).toMatch(
      /if: always\(\) && runner\.os == 'macOS'\n(?:.*\n){3}\s+run: rm -f "\$APPLE_API_KEY"/,
    );
  });

  it("requires Azure signing for Windows in the stable release path", () => {
    expect(signedBuildText).toContain('test -n "$AZURE_CLIENT_ID"');
    expect(signedBuildText).not.toMatch(/windows_signed|WINDOWS_SIGNING|\bunsigned\b/i);
    expect(signedBuildText).not.toContain("-c.forceCodeSigning=false");
    expect(workflow).not.toContain("AZURE_CLIENT_SECRET");
    expect(workflow).toContain("environment: desktop-release");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("azure/login@");
    expect(workflow).toContain("TimeStamperCertificate");
    expect(signedBuildText.match(/--win --x64/g)).toHaveLength(1);
    for (const option of [
      "endpoint",
      "codeSigningAccountName",
      "certificateProfileName",
      "publisherName",
    ]) {
      expect(workflow).toContain(`"-c.win.azureSignOptions.${option}=$`);
    }
    expect(workflow).toContain("is not signed by the configured publisher");
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"},{"os":"windows-2022","artifact":"windows"}]'`,
    );
    const platformSelection = definition.jobs.validate.steps.find(
      (step) => step.id === "platforms",
    );
    expect(platformSelection?.run?.match(/windows-2022/g)).toHaveLength(1);
    expect(workflow).toContain("test -f release-artifacts/latest.yml");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.exe' >/dev/null");
  });

  it("signs every Linux AppImage and publishes its signature", () => {
    expect(workflow).toContain(
      `SIGNING_KEY: ${expression("secrets.DESKTOP_LINUX_UPDATE_SIGNING_KEY")}`,
    );
    expect(workflow).toMatch(/if \[\[ -z "\$SIGNING_KEY" \]\]; then\n.*\n\s+exit 1/);
    expect(workflow).toContain(`trap 'rm -f "$key"' EXIT`);
    expect(workflow).toContain('chmod 600 "$key"');
    expect(workflow).toContain("pnpm exec tsx apps/desktop/scripts/sign-linux-update.ts");
    expect(workflow).toContain("apps/desktop/out/*.AppImage.sig");
    expect(workflow).toContain('if [[ ! -s "$image.sig" ]]; then');
  });

  it("pins every platform update feed to the official GitHub owner and repo", () => {
    expect(workflow).toContain('grep -Fqx "provider: github"');
    expect(workflow).toContain('grep -Fqx "owner: orkbot-run"');
    expect(workflow).toContain('grep -Fqx "repo: ork"');
    expect(workflow).toContain("Verify Linux update feed is pinned to the official GitHub channel");
    expect(workflow).toContain("Windows update config missing");
    expect(workflow).toContain("RELEASE_VERSION:");
    expect(workflow).toContain('grep -Fqx "version: $RELEASE_VERSION"');
  });

  it("adds the system passkey association only when a provisioning profile is configured", () => {
    expect(workflow).toContain(
      `PROVISIONING_PROFILE: ${expression("secrets.DESKTOP_MAC_PROVISIONING_PROFILE")}`,
    );
    expect(workflow).toMatch(/if \[\[ -z "\$PROVISIONING_PROFILE" \]\]; then\n.*\n\s+exit 0/);
    expect(workflow).toContain("pnpm exec tsx apps/desktop/scripts/passkey-entitlements.ts");
    expect(workflow).toContain('if [[ "$app_id" != "$APPLE_TEAM_ID.$bundle_id" ]]; then');
    // Helpers keep entitlementsInherit; only the main app is associated.
    expect(workflow).toContain(
      '"-c.mac.entitlements=$PASSKEY_ENTITLEMENTS" "-c.mac.provisioningProfile=$PASSKEY_PROFILE"',
    );
    expect(workflow).not.toContain("entitlementsInherit=");
    expect(workflow).toContain('test -f "$app/Contents/embedded.provisionprofile"');
    expect(workflow).not.toMatch(/secrets\.APPLE_TEAM_ID/);
  });

  it("publishes only a complete stable, upgrade-only feed", () => {
    expect(workflow).toContain("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)$");
    expect(workflow).toContain("must be newer than published release");
    expect(workflow).toContain("group: release-desktop-stable");
    expect(workflow).toContain("latest.yml");
    expect(workflow).toContain("latest-mac.yml");
    expect(workflow).toContain("latest-linux.yml");
    expect(workflow).toContain(
      '--draft --notes-file "$RUNNER_TEMP/release-notes.md" --generate-notes',
    );
    expect(workflow).toContain("CHANGELOG.md has no [$version] section");
    expect(workflow).toContain("--draft=false --latest");
  });
});
