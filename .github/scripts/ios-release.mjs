// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { spawn } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED = [
  "EXPO_PUBLIC_API_URL",
  "ORK_ACCOUNTS_MOBILE_CLIENT_ID",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_PRIVATE_KEY",
  "IOS_DEVELOPMENT_CERTIFICATE",
  "IOS_DEVELOPMENT_CERTIFICATE_PASSWORD",
  "IOS_DISTRIBUTION_CERTIFICATE",
  "IOS_DISTRIBUTION_CERTIFICATE_PASSWORD",
];
const SECRET_NAMES = REQUIRED.filter(
  (name) => !["EXPO_PUBLIC_API_URL", "ORK_ACCOUNTS_MOBILE_CLIENT_ID"].includes(name),
);

export function releaseConfiguration(env) {
  for (const name of ["BUILD_IOS", "SUBMIT_IOS"])
    if (env[name] !== undefined && !["true", "false"].includes(env[name]))
      throw new Error(`Invalid boolean input: ${name}`);
  const build = env.BUILD_IOS === "true" || env.SUBMIT_IOS === "true";
  const upload = env.SUBMIT_IOS === "true";
  if (!build) return { build, upload };
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (upload && !env.ASC_APP_ID?.trim()) missing.push("ASC_APP_ID");
  if (missing.length) throw new Error(`Missing iOS release configuration: ${missing.join(", ")}`);
  if (upload && env.GITHUB_REF !== "refs/heads/main") throw new Error("iOS upload requires main");
  if (upload && !/^\d+$/.test(env.ASC_APP_ID))
    throw new Error("ASC_APP_ID must be the numeric app Apple ID");
  const api = new URL(env.EXPO_PUBLIC_API_URL);
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error(
      "iOS releases require an HTTPS product API origin without credentials, path, query or fragment",
    );
  if (env.ORK_ACCOUNTS_ISSUER !== "https://api.ork.run")
    throw new Error("Unexpected production Accounts issuer");
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_TEAM_ID))
    throw new Error("Invalid Apple team configuration");
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY) || !/^[a-f0-9-]{36}$/i.test(env.APPLE_API_ISSUER))
    throw new Error("Invalid Apple API metadata");
  const number = Number(env.GITHUB_RUN_NUMBER),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 9999 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    attempt > 99
  )
    throw new Error("Invalid iOS build counter");
  return { build, upload, team: env.APPLE_TEAM_ID, buildNumber: `${number}.${attempt}` };
}

export function redactedDiagnostic(text, env) {
  let safe = String(text);
  for (const name of [...SECRET_NAMES, "ASC_APP_ID"])
    if (env[name]) safe = safe.replaceAll(env[name], "[redacted]");
  safe = safe.replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, "[redacted key]");
  return safe
    .split("\n")
    .filter((line) =>
      /error:|error |failed|requires|provision|signing|missing|invalid|expected|mismatch|refusing/i.test(
        line,
      ),
    )
    .slice(-12)
    .join("\n")
    .slice(-6000);
}

/** Build tools receive public configuration, never the certificate/API-key environment. */
export function buildEnvironment(env) {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "DEVELOPER_DIR",
    "SDKROOT",
    "RUNNER_TRACKING_ID",
    "EXPO_PUBLIC_API_URL",
    "ORK_ACCOUNTS_ISSUER",
    "ORK_ACCOUNTS_MOBILE_CLIENT_ID",
    "EAS_BUILD_PROFILE",
  ];
  return {
    ...Object.fromEntries(
      names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
    ),
    CI: "1",
    EXPO_NO_TELEMETRY: "1",
    NODE_ENV: "production",
  };
}

function keychains(text) {
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  if (text.replace(pattern, "").trim())
    throw new Error("Could not parse signing keychain search list");
  return [...text.matchAll(pattern)].map((match) => JSON.parse(match[0]));
}

export function signingIdentities(output, team, publicCertificates = "") {
  const certificates = new Map(
    (
      publicCertificates.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ??
      []
    ).map((pem) => {
      const certificate = new X509Certificate(pem);
      return [certificate.fingerprint.replaceAll(":", ""), certificate];
    }),
  );
  const identities = [...output.matchAll(/\b([A-F0-9]{40}) "([^"]+)"/g)].map((match) => ({
    sha1: match[1],
    name: match[2],
  }));
  const belongsToTeam = (row) => {
    const certificate = certificates.get(row.sha1);
    const units = certificate?.subject.split("\n").filter((line) => line.startsWith("OU="));
    return units?.length === 1 && units[0] === `OU=${team}`;
  };
  const development = identities.filter(
    (row) => row.name.startsWith("Apple Development:") && belongsToTeam(row),
  );
  const distribution = identities.filter(
    (row) => row.name.startsWith("Apple Distribution:") && belongsToTeam(row),
  );
  if (identities.length !== 2 || development.length !== 1 || distribution.length !== 1)
    throw new Error(
      "Require exactly one matching Apple Development and Apple Distribution signing identity",
    );
  return { development: development[0].sha1, distribution: distribution[0].sha1 };
}

function privateCertificate(value) {
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new Error("Invalid iOS certificate encoding");
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString("base64") !== compact)
    throw new Error("Invalid iOS certificate size or encoding");
  return bytes;
}

export async function prepareSigning(env, directory, run, cleanupRun = run) {
  const key = createPrivateKey(env.APPLE_API_PRIVATE_KEY);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Apple API key must be a P-256 private key");
  mkdirSync(directory, { mode: 0o700 });
  const keychain = path.join(directory, "signing.keychain-db");
  const password = randomBytes(32).toString("base64url");
  writeFileSync(
    path.join(directory, "owner.json"),
    JSON.stringify({ run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT }),
    { mode: 0o600, flag: "wx" },
  );
  let created = false;
  const cleanup = async () => {
    try {
      if (created) {
        try {
          const current = keychains(
            await cleanupRun("/usr/bin/security", ["list-keychains", "-d", "user"]),
          );
          await cleanupRun("/usr/bin/security", [
            "list-keychains",
            "-d",
            "user",
            "-s",
            ...current.filter((item) => item !== keychain),
          ]);
        } finally {
          await cleanupRun("/usr/bin/security", ["delete-keychain", keychain]);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    keychains(await run("/usr/bin/security", ["list-keychains", "-d", "user"]));
    await run("/usr/bin/security", ["create-keychain", "-p", password, keychain]);
    created = true;
    await run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychain]);
    await run("/usr/bin/security", ["unlock-keychain", "-p", password, keychain]);
    for (const kind of ["DEVELOPMENT", "DISTRIBUTION"]) {
      const file = path.join(directory, `${kind.toLowerCase()}.p12`);
      writeFileSync(file, privateCertificate(env[`IOS_${kind}_CERTIFICATE`]), {
        mode: 0o600,
        flag: "wx",
      });
      await run("/usr/bin/security", [
        "import",
        file,
        "-k",
        keychain,
        "-P",
        env[`IOS_${kind}_CERTIFICATE_PASSWORD`],
        "-T",
        "/usr/bin/codesign",
      ]);
      rmSync(file);
    }
    await run("/usr/bin/security", [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    const current = keychains(await run("/usr/bin/security", ["list-keychains", "-d", "user"]));
    await run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychain,
      ...current.filter((item) => item !== keychain),
    ]);
    const identities = signingIdentities(
      await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", keychain]),
      env.APPLE_TEAM_ID,
      await run("/usr/bin/security", ["find-certificate", "-a", "-p", keychain]),
    );
    const apiKey = path.join(directory, "api-key.p8");
    writeFileSync(apiKey, env.APPLE_API_PRIVATE_KEY, { mode: 0o600, flag: "wx" });
    return { keychain, apiKey, identities, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export function exportOptions(team, upload = false) {
  return {
    method: "app-store-connect",
    destination: upload ? "upload" : "export",
    signingStyle: "automatic",
    teamID: team,
    manageAppVersionAndBuildNumber: false,
    uploadSymbols: true,
  };
}

export function archiveArguments(config, mobile, archive) {
  return [
    "-workspace",
    path.join(mobile, "ios/Ork.xcworkspace"),
    "-scheme",
    "Ork",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    `DEVELOPMENT_TEAM=${config.team}`,
    "CODE_SIGN_STYLE=Automatic",
    `CURRENT_PROJECT_VERSION=${config.buildNumber}`,
    "archive",
  ];
}

export function verifyNativePrebuild(mobile) {
  const lock = readFileSync(path.join(mobile, "ios/Podfile.lock"), "utf8");
  for (const name of ["OrkIdentity", "OrkTransport"])
    if (!new RegExp(`\\b${name}\\b`).test(lock)) throw new Error(`Missing native pod: ${name}`);
  const providers = globSync("ios/Pods/**/ExpoModulesProvider.swift", { cwd: mobile })
    .map((file) => readFileSync(path.join(mobile, file), "utf8"))
    .join("\n");
  for (const name of ["OrkIdentityModule", "OrkTransportModule"])
    if (!providers.includes(name)) throw new Error(`Missing autolinked native module: ${name}`);
  if (
    !existsSync(
      path.join(
        mobile,
        "modules/orkbot-transport/generated/apple/OrkInstallationTransport.xcframework/Info.plist",
      ),
    )
  )
    throw new Error("Missing compiled installation transport framework");
  const libraries = globSync(
    "modules/orkbot-transport/generated/apple/OrkInstallationTransport.xcframework/ios-arm64/*.a",
    { cwd: mobile },
  );
  if (
    libraries.length !== 1 ||
    !readFileSync(path.join(mobile, libraries[0])).subarray(0, 8).equals(Buffer.from("!<arch>\n"))
  )
    throw new Error("Missing compiled iOS arm64 installation transport library");
}

export async function verifyExportedApp(app, expected, run, certificateDirectory) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const info = JSON.parse(
    await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Info.plist")]),
  );
  if (
    info.CFBundleIdentifier !== expected.bundle ||
    info.CFBundleShortVersionString !== expected.version ||
    info.CFBundleVersion !== expected.buildNumber
  )
    throw new Error("Exported app identity/version mismatch");
  if (!existsSync(path.join(app, "main.jsbundle")))
    throw new Error("Missing embedded production JavaScript bundle");
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || path.basename(executable) !== executable)
    throw new Error("Invalid app executable metadata");
  const binary = readFileSync(path.join(app, executable));
  for (const name of ["OrkIdentityModule", "OrkTransportModule"])
    if (!binary.includes(Buffer.from(name)))
      throw new Error(`Native release binary does not contain ${name}`);
  const prefix = path.join(certificateDirectory, "export-signature-");
  await run("/usr/bin/codesign", ["-d", "--extract-certificates", prefix, app]);
  const certificate = new X509Certificate(readFileSync(`${prefix}0`));
  if (certificate.fingerprint.replaceAll(":", "") !== expected.distribution)
    throw new Error("Export did not use the dedicated iOS distribution certificate");
  const extensionIds = [];
  for (const [index, extension] of globSync("PlugIns/*.appex", { cwd: app }).entries()) {
    const file = path.join(app, extension, "Info.plist");
    const value = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]));
    if (
      !value.CFBundleIdentifier?.startsWith(`${expected.bundle}.`) ||
      value.CFBundleShortVersionString !== expected.version ||
      value.CFBundleVersion !== expected.buildNumber
    )
      throw new Error("Embedded extension identity/version mismatch");
    extensionIds.push(value.CFBundleIdentifier);
    const extensionPrefix = path.join(certificateDirectory, `extension-signature-${index}-`);
    await run("/usr/bin/codesign", [
      "-d",
      "--extract-certificates",
      extensionPrefix,
      path.join(app, extension),
    ]);
    const extensionCertificate = new X509Certificate(readFileSync(`${extensionPrefix}0`));
    if (extensionCertificate.fingerprint.replaceAll(":", "") !== expected.distribution)
      throw new Error("Embedded extension distribution signature mismatch");
  }
  if (
    JSON.stringify(extensionIds.sort()) !== JSON.stringify([...(expected.extensions ?? [])].sort())
  )
    throw new Error("Exported extension inventory mismatch");
  return {
    bundle: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString,
    buildNumber: info.CFBundleVersion,
    executableSHA256: createHash("sha256").update(binary).digest("hex"),
  };
}

function commandRunner(env, signal) {
  return (command, args, cwd) =>
    new Promise((resolve, reject) => {
      let output = "",
        errors = "";
      const child = spawn(command, args, {
        cwd,
        env: buildEnvironment(env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let killTimer;
      const abort = () => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 5000);
        killTimer.unref();
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk) => {
        output = (output + chunk).slice(-2 * 1024 * 1024);
      });
      child.stderr.on("data", (chunk) => {
        errors = (errors + chunk).slice(-256 * 1024);
      });
      child.once("error", () => {
        signal.removeEventListener("abort", abort);
        reject(new Error(`iOS tool unavailable: ${path.basename(command)}`));
      });
      child.once("close", (code) => {
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (code === 0) resolve(output);
        else
          reject(
            new Error(
              `${path.basename(command)} failed (${code}): ${redactedDiagnostic(errors + output, env)}`,
            ),
          );
      });
    });
}

export async function buildRelease(env, root, run, checkApp, cleanupRun = run) {
  const config = releaseConfiguration(env);
  if (!config.build) return;
  const temporary = realpathSync(env.RUNNER_TEMP);
  const signingDirectory = path.join(temporary, "ork-ios-signing");
  const artifacts = path.join(temporary, "ork-ios-artifacts");
  mkdirSync(artifacts, { mode: 0o700 });
  const mobile = path.join(root, "apps/mobile");
  const appConfig = JSON.parse(readFileSync(path.join(mobile, "app.json"), "utf8")).expo;
  verifyNativePrebuild(mobile);
  const signing = await prepareSigning(env, signingDirectory, run, cleanupRun);
  try {
    const authentication = [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      signing.apiKey,
      "-authenticationKeyID",
      env.APPLE_API_KEY,
      "-authenticationKeyIssuerID",
      env.APPLE_API_ISSUER,
    ];
    const archive = path.join(temporary, "Ork.xcarchive");
    console.log("Archiving native iOS app");
    await run(
      "/usr/bin/xcodebuild",
      [...archiveArguments(config, mobile, archive), ...authentication],
      root,
    );
    const plist = path.join(signingDirectory, "export.json");
    writeFileSync(plist, JSON.stringify(exportOptions(config.team)), { mode: 0o600 });
    await run("/usr/bin/plutil", ["-convert", "xml1", plist]);
    const exported = path.join(temporary, "ork-ios-export");
    await run(
      "/usr/bin/xcodebuild",
      [
        "-exportArchive",
        "-archivePath",
        archive,
        "-exportOptionsPlist",
        plist,
        "-exportPath",
        exported,
        ...authentication,
      ],
      root,
    );
    const packages = globSync("*.ipa", { cwd: exported });
    if (packages.length !== 1) throw new Error("Expected exactly one exported IPA");
    const ipa = path.join(exported, packages[0]);
    const unpacked = path.join(signingDirectory, "verified-ipa");
    await run("/usr/bin/ditto", ["-x", "-k", ipa, unpacked]);
    const apps = globSync("Payload/*.app", { cwd: unpacked });
    if (apps.length !== 1) throw new Error("Expected exactly one exported application");
    const receipt = await verifyExportedApp(
      path.join(unpacked, apps[0]),
      {
        bundle: appConfig.ios.bundleIdentifier,
        version: appConfig.version,
        buildNumber: config.buildNumber,
        distribution: signing.identities.distribution,
        extensions:
          appConfig.extra?.eas?.build?.experimental?.ios?.appExtensions?.map(
            (extension) => extension.bundleIdentifier,
          ) ?? [],
      },
      run,
      signingDirectory,
    );
    const bytes = readFileSync(ipa);
    writeFileSync(path.join(artifacts, "Ork.ipa"), bytes, { mode: 0o600, flag: "wx" });
    if (config.upload) {
      await checkApp(env.ASC_APP_ID, receipt.bundle);
      writeFileSync(plist, JSON.stringify(exportOptions(config.team, true)), { mode: 0o600 });
      await run("/usr/bin/plutil", ["-convert", "xml1", plist]);
      await run(
        "/usr/bin/xcodebuild",
        [
          "-exportArchive",
          "-archivePath",
          archive,
          "-exportOptionsPlist",
          plist,
          ...authentication,
        ],
        root,
      );
    }
    writeFileSync(
      path.join(artifacts, "verification.json"),
      JSON.stringify(
        {
          ...receipt,
          sourceRevision: env.GITHUB_SHA,
          ipaSHA256: createHash("sha256").update(bytes).digest("hex"),
          nativeModules: ["OrkIdentityModule", "OrkTransportModule"],
          uploaded: config.upload,
          appReviewSubmitted: false,
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
    if (env.RELEASE_NOTES)
      writeFileSync(path.join(artifacts, "release-notes.txt"), env.RELEASE_NOTES, {
        mode: 0o600,
        flag: "wx",
      });
  } finally {
    await signing.cleanup();
  }
}

export async function cleanupInterrupted(env, run) {
  const directory = path.join(realpathSync(env.RUNNER_TEMP), "ork-ios-signing");
  if (!existsSync(directory)) return;
  const ownerFile = path.join(directory, "owner.json");
  if (
    !lstatSync(directory).isDirectory() ||
    realpathSync(directory) !== directory ||
    !lstatSync(ownerFile).isFile()
  )
    throw new Error("Refusing cleanup of redirected signing material");
  const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
  if (owner.run !== env.GITHUB_RUN_ID || owner.attempt !== env.GITHUB_RUN_ATTEMPT)
    throw new Error("Refusing cleanup of another signing operation");
  const file = path.join(directory, "signing.keychain-db");
  try {
    const current = keychains(await run("/usr/bin/security", ["list-keychains", "-d", "user"]));
    await run("/usr/bin/security", [
      "list-keychains",
      "-d",
      "user",
      "-s",
      ...current.filter((item) => item !== file),
    ]);
    if (existsSync(file)) await run("/usr/bin/security", ["delete-keychain", file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const run = commandRunner(process.env, controller.signal);
  try {
    const credentials = process.env;
    if (process.argv[2] === "check") releaseConfiguration(process.env);
    else if (process.argv[2] === "cleanup") await cleanupInterrupted(process.env, run);
    else if (process.argv[2] === "build")
      await buildRelease(
        process.env,
        process.cwd(),
        run,
        async (appId, bundle) => {
          const { appStoreClient } = await import("./app-store-review.mjs");
          const { appleSystemFetch } = await import(
            "../../apps/desktop/scripts/macos-personal-profile.ts"
          );
          const request = appStoreClient(
            {
              keyId: credentials.APPLE_API_KEY,
              issuerId: credentials.APPLE_API_ISSUER,
              privateKey: credentials.APPLE_API_PRIVATE_KEY,
            },
            appleSystemFetch(),
          );
          const app = await request("GET", `/v1/apps/${appId}`);
          if (app.data?.attributes?.bundleId !== bundle)
            throw new Error("App Store app identifier does not match exported app");
        },
        commandRunner(process.env, new AbortController().signal),
      );
    else throw new Error("Expected check, build or cleanup");
  } catch (error) {
    console.error(
      redactedDiagnostic(
        error instanceof Error ? error.message : "iOS release failed",
        process.env,
      ) || "iOS release failed",
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
