import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify, X509Certificate } from "node:crypto";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appStoreClient, appStoreToken, submitForReview } from "./app-store-review.mjs";
import {
  archiveArguments,
  buildEnvironment,
  buildRelease,
  cleanupInterrupted,
  exportOptions,
  prepareSigning,
  redactedDiagnostic,
  releaseConfiguration,
  signingIdentities,
  verifyExportedApp,
  verifyNativePrebuild,
} from "./ios-release.mjs";

const options = {
  appId: "app-1",
  version: "2.0.0",
  buildNumber: "7",
  notes: "Example notes.",
  sleep: async () => {},
  timeoutMs: 60_000,
};

function iosFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ork-ios-release-test-"));
  const temporary = path.join(root, "temporary");
  mkdirSync(temporary);
  const mobile = path.join(root, "apps/mobile");
  mkdirSync(mobile, { recursive: true });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" });
  const keyFile = path.join(root, "fixture.pem");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const certificate = path.join(root, "fixture.der");
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      keyFile,
      "-subj",
      "/CN=Apple Distribution: Fixture (ABCDEFGHIJ)/OU=ABCDEFGHIJ",
      "-days",
      "1",
      "-outform",
      "DER",
      "-out",
      certificate,
    ],
    { stdio: "pipe" },
  );
  const fingerprint = new X509Certificate(readFileSync(certificate)).fingerprint.replaceAll(
    ":",
    "",
  );
  const developmentCertificate = path.join(root, "development.der");
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      keyFile,
      "-subj",
      "/CN=Apple Development: Fixture (PERSONID01)/OU=ABCDEFGHIJ",
      "-days",
      "1",
      "-outform",
      "DER",
      "-out",
      developmentCertificate,
    ],
    { stdio: "pipe" },
  );
  const development = new X509Certificate(readFileSync(developmentCertificate));
  const publicCertificates = `${development.toString()}\n${new X509Certificate(readFileSync(certificate)).toString()}`;
  const identityOutput = `1) ${development.fingerprint.replaceAll(":", "")} "Apple Development: Fixture (PERSONID01)"\n2) ${fingerprint} "Apple Distribution: Fixture (ABCDEFGHIJ)"\n2 valid identities found`;
  const env = {
    BUILD_IOS: "true",
    SUBMIT_IOS: "false",
    GITHUB_REF: "refs/heads/feature",
    GITHUB_RUN_ID: "fake-run",
    GITHUB_RUN_NUMBER: "17",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "a".repeat(40),
    RUNNER_TEMP: temporary,
    EAS_BUILD_PROFILE: "production",
    EXPO_PUBLIC_API_URL: "https://product.example.test",
    ORK_ACCOUNTS_ISSUER: "https://api.ork.run",
    ORK_ACCOUNTS_MOBILE_CLIENT_ID: "registered-client",
    APPLE_TEAM_ID: "ABCDEFGHIJ",
    APPLE_API_KEY: "KLMNOPQRST",
    APPLE_API_ISSUER: "12345678-1234-1234-1234-123456789abc",
    APPLE_API_PRIVATE_KEY: key,
    IOS_DEVELOPMENT_CERTIFICATE: Buffer.from("fake-development-p12").toString("base64"),
    IOS_DEVELOPMENT_CERTIFICATE_PASSWORD: "dev-password",
    IOS_DISTRIBUTION_CERTIFICATE: Buffer.from("fake-distribution-p12").toString("base64"),
    IOS_DISTRIBUTION_CERTIFICATE_PASSWORD: "distribution-password",
  };
  const write = (name, contents) => {
    const file = path.join(mobile, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  write(
    "app.json",
    JSON.stringify({ expo: { version: "1.3.0", ios: { bundleIdentifier: "run.orkbot.app" } } }),
  );
  write("ios/Podfile.lock", "- OrkIdentity (0.1.0)\n- OrkTransport (0.1.0)");
  write(
    "ios/Pods/Target Support Files/Pods-Ork/ExpoModulesProvider.swift",
    "OrkIdentityModule.self, OrkTransportModule.self",
  );
  write(
    "modules/orkbot-transport/generated/apple/OrkInstallationTransport.xcframework/Info.plist",
    "fixture",
  );
  write(
    "modules/orkbot-transport/generated/apple/OrkInstallationTransport.xcframework/ios-arm64/libork_installation_transport.a",
    "!<arch>\nfixture",
  );
  const calls = [],
    destinations = [];
  let list = ["/unrelated/login.keychain-db"];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command.endsWith("/security")) {
      if (args[0] === "list-keychains") {
        if (args.includes("-s")) list = args.slice(args.indexOf("-s") + 1);
        return list.map((item) => JSON.stringify(item)).join("\n");
      }
      if (args[0] === "create-keychain")
        writeFileSync(args.at(-1), "fake keychain", { mode: 0o600 });
      if (args[0] === "delete-keychain") rmSync(args[1], { force: true });
      if (args[0] === "import") assert.equal(statSync(args[1]).mode & 0o777, 0o600);
      if (args[0] === "find-identity") return identityOutput;
      if (args[0] === "find-certificate") return publicCertificates;
      return "";
    }
    if (command.endsWith("/xcodebuild") && args.includes("-exportArchive")) {
      const configuration = JSON.parse(
        readFileSync(args[args.indexOf("-exportOptionsPlist") + 1], "utf8"),
      );
      destinations.push(configuration.destination);
      if (configuration.destination === "export") {
        const directory = args[args.indexOf("-exportPath") + 1];
        mkdirSync(directory);
        writeFileSync(path.join(directory, "Ork.ipa"), "fake package");
      }
    }
    if (command.endsWith("/plutil") && args.includes("-o"))
      return readFileSync(args.at(-1), "utf8");
    if (command.endsWith("/ditto")) {
      const app = path.join(args.at(-1), "Payload/Ork.app");
      mkdirSync(app, { recursive: true });
      writeFileSync(
        path.join(app, "Info.plist"),
        JSON.stringify({
          CFBundleIdentifier: "run.orkbot.app",
          CFBundleShortVersionString: "1.3.0",
          CFBundleVersion: "17.2",
          CFBundleExecutable: "Ork",
        }),
      );
      writeFileSync(path.join(app, "main.jsbundle"), "embedded production bundle");
      writeFileSync(path.join(app, "Ork"), "OrkIdentityModule\0OrkTransportModule");
    }
    if (command.endsWith("/codesign") && args.includes("--extract-certificates"))
      writeFileSync(
        `${args[args.indexOf("--extract-certificates") + 1]}0`,
        readFileSync(certificate),
      );
    return "";
  };
  return {
    root,
    temporary,
    mobile,
    env,
    run,
    calls,
    destinations,
    fingerprint,
    publicCertificates,
    identityOutput,
    list: () => list,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("iOS artifact configuration requires Apple signing and public endpoints, without Expo/EAS authentication or ASC app ID", () => {
  const fixture = iosFixture();
  try {
    assert.deepEqual(releaseConfiguration(fixture.env), {
      build: true,
      upload: false,
      team: "ABCDEFGHIJ",
      buildNumber: "17.2",
    });
    for (const name of [
      "IOS_DEVELOPMENT_CERTIFICATE",
      "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD",
      "APPLE_API_PRIVATE_KEY",
      "ORK_ACCOUNTS_MOBILE_CLIENT_ID",
    ])
      assert.throws(() => releaseConfiguration({ ...fixture.env, [name]: "" }), new RegExp(name));
    assert.throws(
      () =>
        releaseConfiguration({
          ...fixture.env,
          EXPO_PUBLIC_API_URL: "http://product.example.test",
        }),
      /HTTPS/,
    );
    assert.throws(
      () =>
        releaseConfiguration({
          ...fixture.env,
          EXPO_PUBLIC_API_URL: "https://user:password@product.example.test",
        }),
      /credentials/,
    );
    for (const api of [
      "https://product.example.test/api",
      "https://product.example.test/?token=fake",
      "https://product.example.test/#fragment",
    ]) {
      assert.throws(
        () => releaseConfiguration({ ...fixture.env, EXPO_PUBLIC_API_URL: api }),
        /origin/,
      );
    }
    assert.throws(
      () => releaseConfiguration({ ...fixture.env, GITHUB_RUN_NUMBER: "not-a-counter" }),
      /counter/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("iOS upload requires main and an actual app ID; default artifact export never uploads or submits for review", () => {
  const fixture = iosFixture();
  try {
    assert.throws(() => releaseConfiguration({ ...fixture.env, SUBMIT_IOS: "true" }), /ASC_APP_ID/);
    assert.throws(
      () => releaseConfiguration({ ...fixture.env, SUBMIT_IOS: "true", ASC_APP_ID: "123" }),
      /main/,
    );
    assert.equal(
      releaseConfiguration({
        ...fixture.env,
        SUBMIT_IOS: "true",
        ASC_APP_ID: "123",
        GITHUB_REF: "refs/heads/main",
      }).upload,
      true,
    );
    assert.equal(exportOptions("ABCDEFGHIJ").destination, "export");
    assert.equal(exportOptions("ABCDEFGHIJ", true).destination, "upload");
    const args = archiveArguments(releaseConfiguration(fixture.env), fixture.mobile, "/archive");
    assert.ok(args.includes("CODE_SIGN_STYLE=Automatic"));
    assert.ok(!args.some((arg) => arg.startsWith("CODE_SIGN_IDENTITY=")));
    assert.ok(args.includes("generic/platform=iOS"));
  } finally {
    fixture.cleanup();
  }
});

test("iOS build children and diagnostics do not expose certificate/API credentials", () => {
  const fixture = iosFixture();
  try {
    const child = buildEnvironment({
      ...fixture.env,
      PATH: "/tools",
      EXPO_TOKEN: "not-a-live-token",
      GITHUB_TOKEN: "not-a-github-token",
    });
    assert.equal(child.EXPO_PUBLIC_API_URL, fixture.env.EXPO_PUBLIC_API_URL);
    assert.equal(child.EAS_BUILD_PROFILE, "production");
    for (const name of Object.keys(fixture.env).filter(
      (name) => name.startsWith("APPLE_") || name.startsWith("IOS_"),
    ))
      assert.equal(child[name], undefined);
    assert.equal(child.EXPO_TOKEN, undefined);
    assert.equal(child.GITHUB_TOKEN, undefined);
    const diagnostic = redactedDiagnostic(
      `error: ${fixture.env.IOS_DEVELOPMENT_CERTIFICATE_PASSWORD} ${fixture.env.APPLE_API_KEY} ${fixture.env.APPLE_API_PRIVATE_KEY}`,
      fixture.env,
    );
    assert.ok(!diagnostic.includes(fixture.env.IOS_DEVELOPMENT_CERTIFICATE_PASSWORD));
    assert.ok(!diagnostic.includes("BEGIN PRIVATE KEY"));
  } finally {
    fixture.cleanup();
  }
});

test("dedicated iOS keychain imports both identities and removes only its own search-list entry", async () => {
  const fixture = iosFixture();
  try {
    const directory = path.join(fixture.temporary, "signing");
    const signing = await prepareSigning(fixture.env, directory, fixture.run);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(signing.apiKey).mode & 0o777, 0o600);
    assert.equal(fixture.calls.filter((call) => call.args[0] === "import").length, 2);
    assert.ok(!existsSync(path.join(directory, "development.p12")));
    assert.ok(!existsSync(path.join(directory, "distribution.p12")));
    await fixture.run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...fixture.list(),
      "/unrelated/later.keychain-db",
    ]);
    await signing.cleanup();
    assert.deepEqual(fixture.list(), [
      "/unrelated/login.keychain-db",
      "/unrelated/later.keychain-db",
    ]);
    assert.ok(!existsSync(directory));
  } finally {
    fixture.cleanup();
  }
});

test("failed second certificate import still deletes signing material and restores unrelated keychains", async () => {
  const fixture = iosFixture();
  let imports = 0;
  try {
    const directory = path.join(fixture.temporary, "signing");
    await assert.rejects(
      prepareSigning(fixture.env, directory, async (...args) => {
        if (args[1][0] === "import" && ++imports === 2) throw new Error("signing import failed");
        return fixture.run(...args);
      }),
      /import failed/,
    );
    assert.ok(!existsSync(directory));
    assert.deepEqual(fixture.list(), ["/unrelated/login.keychain-db"]);
    assert.ok(fixture.calls.some((call) => call.args[0] === "delete-keychain"));
  } finally {
    fixture.cleanup();
  }
});

test("wrong-team, missing development, duplicate and macOS Developer ID identities fail closed", () => {
  for (const output of [
    `${"A".repeat(40)} "Apple Distribution: Fixture (ABCDEFGHIJ)"`,
    `${"A".repeat(40)} "Developer ID Application: Fixture (ABCDEFGHIJ)"\n${"B".repeat(40)} "Apple Distribution: Fixture (ABCDEFGHIJ)"`,
    `${"A".repeat(40)} "Apple Development: Fixture (OTHERTEAM1)"\n${"B".repeat(40)} "Apple Distribution: Fixture (ABCDEFGHIJ)"`,
  ])
    assert.throws(() => signingIdentities(output, "ABCDEFGHIJ"), /exactly one/);
});

test("iOS team validation uses the certificate OU and identity fingerprint, not a development CN suffix", () => {
  const fixture = iosFixture();
  try {
    assert.ok(fixture.identityOutput.includes("Apple Development: Fixture (PERSONID01)"));
    assert.equal(
      signingIdentities(
        fixture.identityOutput,
        fixture.env.APPLE_TEAM_ID,
        fixture.publicCertificates,
      ).distribution,
      fixture.fingerprint,
    );
    assert.throws(
      () => signingIdentities(fixture.identityOutput, "OTHERTEAM1", fixture.publicCertificates),
      /exactly one/,
    );
    assert.throws(
      () => signingIdentities(fixture.identityOutput, fixture.env.APPLE_TEAM_ID, ""),
      /exactly one/,
    );
    assert.throws(
      () =>
        signingIdentities(
          fixture.identityOutput.replace(fixture.fingerprint, "B".repeat(40)),
          fixture.env.APPLE_TEAM_ID,
          fixture.publicCertificates,
        ),
      /exactly one/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("native prebuild verification refuses a missing pod, autolinked module or transport framework", () => {
  const fixture = iosFixture();
  try {
    verifyNativePrebuild(fixture.mobile);
    writeFileSync(path.join(fixture.mobile, "ios/Podfile.lock"), "OrkIdentity");
    assert.throws(() => verifyNativePrebuild(fixture.mobile), /OrkTransport/);
    writeFileSync(path.join(fixture.mobile, "ios/Podfile.lock"), "OrkIdentity OrkTransport");
    writeFileSync(
      path.join(fixture.mobile, "ios/Pods/Target Support Files/Pods-Ork/ExpoModulesProvider.swift"),
      "OrkIdentityModule",
    );
    assert.throws(() => verifyNativePrebuild(fixture.mobile), /OrkTransportModule/);
  } finally {
    fixture.cleanup();
  }
});

test("artifact build verifies native binary/signature and never contacts an App Store app", async () => {
  const fixture = iosFixture();
  try {
    await buildRelease(fixture.env, fixture.root, fixture.run, async () => {
      assert.fail("Artifact build contacted App Store app");
    });
    assert.deepEqual(fixture.destinations, ["export"]);
    const receipt = JSON.parse(
      readFileSync(path.join(fixture.temporary, "ork-ios-artifacts/verification.json"), "utf8"),
    );
    assert.equal(receipt.uploaded, false);
    assert.equal(receipt.appReviewSubmitted, false);
    assert.deepEqual(receipt.nativeModules, ["OrkIdentityModule", "OrkTransportModule"]);
    assert.ok(!existsSync(path.join(fixture.temporary, "ork-ios-signing")));
    assert.ok(
      fixture.calls.some(
        (call) => call.command.endsWith("codesign") && call.args.includes("--strict"),
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("explicit upload checks the matching App Store app after verification and before upload", async () => {
  const fixture = iosFixture();
  let checked = false;
  try {
    await buildRelease(
      { ...fixture.env, SUBMIT_IOS: "true", GITHUB_REF: "refs/heads/main", ASC_APP_ID: "123" },
      fixture.root,
      fixture.run,
      async (appId, bundle) => {
        assert.equal(appId, "123");
        assert.equal(bundle, "run.orkbot.app");
        assert.deepEqual(fixture.destinations, ["export"]);
        checked = true;
      },
    );
    assert.ok(checked);
    assert.deepEqual(fixture.destinations, ["export", "upload"]);
  } finally {
    fixture.cleanup();
  }
});

test("app mismatch, archive failure, signature failure and missing native binary prevent upload and clean credentials", async () => {
  for (const failure of ["app", "archive", "signature", "native"]) {
    const fixture = iosFixture();
    try {
      const run = async (...args) => {
        if (failure === "signature" && args[0].endsWith("codesign") && args[1].includes("--verify"))
          throw new Error("signature failed");
        if (failure === "archive" && args[0].endsWith("xcodebuild") && args[1].includes("archive"))
          throw new Error("archive failed");
        const value = await fixture.run(...args);
        if (failure === "native" && args[0].endsWith("ditto"))
          writeFileSync(path.join(args[1].at(-1), "Payload/Ork.app/Ork"), "OrkIdentityModule");
        return value;
      };
      await assert.rejects(
        buildRelease(
          { ...fixture.env, SUBMIT_IOS: "true", GITHUB_REF: "refs/heads/main", ASC_APP_ID: "123" },
          fixture.root,
          run,
          async () => {
            throw new Error("app mismatch");
          },
        ),
      );
      assert.ok(!fixture.destinations.includes("upload"));
      assert.ok(!existsSync(path.join(fixture.temporary, "ork-ios-signing")));
      assert.ok(!existsSync(path.join(fixture.temporary, "ork-ios-artifacts/verification.json")));
    } finally {
      fixture.cleanup();
    }
  }
});

test("interrupted signing cleanup refuses another operation's files", async () => {
  const fixture = iosFixture();
  try {
    const directory = path.join(fixture.temporary, "ork-ios-signing");
    mkdirSync(directory);
    writeFileSync(
      path.join(directory, "owner.json"),
      JSON.stringify({ run: "somebody-else", attempt: "2" }),
    );
    await assert.rejects(cleanupInterrupted(fixture.env, fixture.run), /another signing operation/);
    assert.ok(existsSync(directory));
    assert.equal(fixture.calls.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("cancelled archive uses independent cleanup rather than the cancelled build runner", async () => {
  const fixture = iosFixture();
  let cancelled = false;
  try {
    const run = async (...args) => {
      if (args[0].endsWith("xcodebuild") && args[1].includes("archive")) {
        cancelled = true;
        throw new Error("archive cancelled");
      }
      if (cancelled) throw new Error("cancelled runner cannot perform cleanup");
      return fixture.run(...args);
    };
    await assert.rejects(
      buildRelease(
        fixture.env,
        fixture.root,
        run,
        async () => assert.fail("No upload"),
        fixture.run,
      ),
      /cancelled/,
    );
    assert.deepEqual(fixture.list(), ["/unrelated/login.keychain-db"]);
    assert.ok(!existsSync(path.join(fixture.temporary, "ork-ios-signing")));
  } finally {
    fixture.cleanup();
  }
});

test("export verification checks extension inventory, versions and distribution certificate", async () => {
  const fixture = iosFixture();
  try {
    const unpacked = path.join(fixture.temporary, "unpacked");
    await fixture.run("/usr/bin/ditto", ["-x", "-k", "fixture.ipa", unpacked]);
    const app = path.join(unpacked, "Payload/Ork.app");
    const extension = path.join(app, "PlugIns/Fixture.appex");
    mkdirSync(extension, { recursive: true });
    const metadata = {
      CFBundleIdentifier: "run.orkbot.app.fixture",
      CFBundleShortVersionString: "1.3.0",
      CFBundleVersion: "17.2",
    };
    const info = path.join(extension, "Info.plist");
    writeFileSync(info, JSON.stringify(metadata));
    const expected = {
      bundle: "run.orkbot.app",
      version: "1.3.0",
      buildNumber: "17.2",
      distribution: fixture.fingerprint,
      extensions: [metadata.CFBundleIdentifier],
    };
    await verifyExportedApp(app, expected, fixture.run, fixture.temporary);
    await assert.rejects(
      verifyExportedApp(app, { ...expected, extensions: [] }, fixture.run, fixture.temporary),
      /inventory/,
    );
    writeFileSync(info, JSON.stringify({ ...metadata, CFBundleVersion: "1" }));
    await assert.rejects(
      verifyExportedApp(app, expected, fixture.run, fixture.temporary),
      /version/,
    );
    writeFileSync(info, JSON.stringify(metadata));
    await assert.rejects(
      verifyExportedApp(
        app,
        { ...expected, distribution: "B".repeat(40) },
        fixture.run,
        fixture.temporary,
      ),
      /distribution certificate/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("active workflow keeps iOS on native GitHub build and explicit upload without automatic review or EAS credentials", () => {
  const source = readFileSync(new URL("../workflows/release-mobile.yml", import.meta.url), "utf8");
  const ios = source.split("  ios:\n")[1].split("  android:\n")[0];
  assert.match(ios, /runs-on: xcode-27/);
  assert.match(ios, /DEVELOPER_DIR: \/Applications\/Xcode_27\.2\.app\/Contents\/Developer/);
  assert.match(ios, /grep -E '\^Xcode \(27/);
  assert.match(ios, /expo prebuild --platform ios --no-install/);
  assert.match(ios, /if: inputs.build_ios \|\| inputs.submit_ios/);
  assert.match(ios, /if: always\(\)\n {8}run: node \.github\/scripts\/ios-release\.mjs cleanup/);
  assert.match(ios, /path: \$\{\{ runner.temp \}\}\/ork-ios-artifacts\//);
  assert.doesNotMatch(
    ios,
    /EXPO_TOKEN|EXPO_PROJECT_ID|EXPO_OWNER|eas build|eas submit|run: node \.github\/scripts\/app-store-review\.mjs/,
  );
  assert.match(source, /submit_ios:[\s\S]*?default: false/);
  assert.match(source, /uses: \.\/\.github\/workflows\/release-android-apk.yml/);
});

test("automatic iOS builds accept pull requests without signing or publishing authority", () => {
  const source = readFileSync(new URL("../workflows/ios-build.yml", import.meta.url), "utf8");
  assert.match(source, /push:\n\s+branches: \[main\]/);
  assert.match(source, /pull_request:/);
  assert.match(source, /permissions:\n\s+contents: read/);
  assert.match(source, /persist-credentials: false/);
  assert.doesNotMatch(source, /pull_request_target|secrets[.[]|contents: write|id-token: write/);
  assert.doesNotMatch(source, /eas build|eas submit|altool|allowProvisioningUpdates/);
  assert.match(source, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(source, /CODE_SIGNING_REQUIRED=NO/);
  assert.match(source, /CODE_SIGN_IDENTITY=""/);
  assert.match(source, /DEVELOPMENT_TEAM=""/);
});

test("automatic iOS builds embed JavaScript and retain a simulator app artifact", () => {
  const source = readFileSync(new URL("../workflows/ios-build.yml", import.meta.url), "utf8");
  assert.match(source, /expo prebuild --platform ios --no-install/);
  assert.match(source, /-configuration Release/);
  assert.match(source, /-sdk iphonesimulator/);
  assert.match(source, /generic\/platform=iOS Simulator/);
  assert.match(source, /test -s "\$app\/main\.jsbundle"/);
  assert.match(source, /CFBundleSupportedPlatforms:0/);
  assert.match(source, /ditto -c -k --sequesterRsrc --keepParent/);
  assert.match(source, /uses: actions\/upload-artifact@/);
  assert.match(source, /if-no-files-found: error/);
});

test("automatic iOS paths include the runtime workspace closure, including leaf packages", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const source = readFileSync(new URL("../workflows/ios-build.yml", import.meta.url), "utf8");
  const packages = new Map(
    globSync("packages/*/package.json", { cwd: root }).map((file) => {
      const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
      return [manifest.name, { directory: path.dirname(file), manifest }];
    }),
  );
  const seen = new Set(["apps/mobile"]);
  const visit = (manifest) => {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!version.startsWith("workspace:")) continue;
      const dependency = packages.get(name);
      assert.ok(dependency, `Missing workspace dependency: ${name}`);
      if (seen.has(dependency.directory)) continue;
      seen.add(dependency.directory);
      visit(dependency.manifest);
    }
  };
  visit(JSON.parse(readFileSync(path.join(root, "apps/mobile/package.json"), "utf8")));
  for (const directory of seen)
    assert.equal(source.split(`'${directory}/**'`).length - 1, 2, `${directory} on push and PR`);
});

function fakeAppStore({ buildStates = ["VALID"], existingVersion } = {}) {
  const calls = [];
  const request = async (method, path, data) => {
    calls.push({ method, path, data });
    if (path.startsWith("/v1/builds?")) {
      const state = buildStates.length > 1 ? buildStates.shift() : buildStates[0];
      return { data: state ? [{ id: "build-7", attributes: { processingState: state } }] : [] };
    }
    if (path.startsWith("/v1/apps/app-1/appStoreVersions"))
      return { data: existingVersion ? [existingVersion] : [] };
    if (method === "POST" && path === "/v1/appStoreVersions")
      return { data: { id: "version-new" } };
    if (path.endsWith("/appStoreVersionLocalizations"))
      return { data: [{ id: "loc-en" }, { id: "loc-de" }] };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "sub-1" } };
    return { data: {} };
  };
  return { calls, request };
}

const summary = (calls) =>
  calls.filter(({ method }) => method !== "GET").map(({ method, path }) => `${method} ${path}`);

test("waits for processing, then creates the version with notes and submits it", async () => {
  const store = fakeAppStore({ buildStates: [undefined, "PROCESSING", "VALID"] });
  await submitForReview(store.request, options);
  assert.equal(store.calls.filter(({ path }) => path.startsWith("/v1/builds?")).length, 3);
  assert.deepEqual(summary(store.calls), [
    "POST /v1/appStoreVersions",
    "PATCH /v1/appStoreVersionLocalizations/loc-en",
    "PATCH /v1/appStoreVersionLocalizations/loc-de",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/sub-1",
  ]);
  const created = store.calls.find(({ path }) => path === "/v1/appStoreVersions").data;
  assert.equal(created.attributes.versionString, "2.0.0");
  assert.equal(created.relationships.build.data.id, "build-7");
  const notes = store.calls.find(({ path }) => path.endsWith("/loc-en")).data;
  assert.equal(notes.attributes.whatsNew, "Example notes.");
  const submitted = store.calls.at(-1).data;
  assert.equal(submitted.attributes.submitted, true);
});

test("puts the build on a version still being prepared and releases it on approval", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } },
  });
  await submitForReview(store.request, options);
  const updated = store.calls.find(({ method }) => method !== "GET");
  assert.equal(updated.path, "/v1/appStoreVersions/version-old");
  assert.equal(updated.data.attributes.releaseType, "AFTER_APPROVAL");
  assert.equal(updated.data.relationships.build.data.id, "build-7");
  assert.equal(store.calls.at(-1).path, "/v1/reviewSubmissions/sub-1");
});

test("leaves a version that is already in review alone", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "WAITING_FOR_REVIEW" } },
  });
  await submitForReview(store.request, options);
  assert.deepEqual(summary(store.calls), []);
});

test("stops when Apple rejects the build", async () => {
  const store = fakeAppStore({ buildStates: ["INVALID"] });
  await assert.rejects(submitForReview(store.request, options), /could not process build 7/);
});

test("stops when the build never finishes processing", async () => {
  const store = fakeAppStore({ buildStates: ["PROCESSING"] });
  await assert.rejects(
    submitForReview(store.request, { ...options, timeoutMs: -1 }),
    /not processed in time/,
  );
});

test("signs requests with an ES256 token Apple can verify", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentials = {
    keyId: "KEY123",
    issuerId: "issuer-example",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const [header, claims, signature] = appStoreToken(credentials, 1_000_000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
    iss: "issuer-example",
    iat: 1000,
    exp: 1600,
    aud: "appstoreconnect-v1",
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );

  const request = appStoreClient(credentials, async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ errors: [{ detail: "Another version is editable" }] }),
  }));
  await assert.rejects(request("GET", "/v1/apps"), /409: Another version is editable/);
});
