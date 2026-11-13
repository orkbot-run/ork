// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { withDangerousMod, withProjectBuildGradle } = require("expo/config-plugins");

module.exports = function withInstallationTransport(config) {
  config = withProjectBuildGradle(config, (configuration) => {
    const marker = "// Ork installation transport certificate verifier";
    if (!configuration.modResults.contents.includes(marker))
      configuration.modResults.contents += `
${marker}
allprojects {
  repositories {
    maven {
      url 'https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/'
      content { includeGroup 'org.rustls' }
    }
  }
}
`;
    return configuration;
  });
  for (const [platform, name, exported] of [
    ["ios", "build-apple.mjs", "buildAppleTransport"],
    ["android", "build-android.mjs", "buildAndroidTransport"],
  ])
    config = withDangerousMod(config, [
      platform,
      async (configuration) => {
        const script = path.resolve(__dirname, `../../../packages/client-transport/native/${name}`);
        const build = await import(pathToFileURL(script).href);
        await build[exported]();
        return configuration;
      },
    ]);
  return config;
};
