// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache extension fixes are preserved; share scheme metadata changes follow LICENSE.md.

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const {
  AndroidConfig,
  withFinalizedMod,
  withStringsXml,
  withXcodeProject,
} = require("expo/config-plugins");
const plist = createRequire(require.resolve("expo/config-plugins"))("@expo/plist").default;
const { giveGroupOwnFiles } = require("./pbx-group");

const TARGET = "expo-sharing-extension";
const DISPLAY_NAME = /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/;

/** Gives the extension the app's name, which iOS shows under the icon in the share sheet. */
function renameShareExtension(infoPlist, name) {
  if (!DISPLAY_NAME.test(infoPlist)) throw new Error(`${TARGET} Info.plist has no display name`);
  return infoPlist.replace(DISPLAY_NAME, (_, open, close) => `${open}${name}${close}`);
}

/** expo-sharing's group reuses another extension's `Info.plist` reference, which Xcode rejects. */
function separateShareExtensionFiles(project) {
  const groups = project.hash.project.objects.PBXGroup;
  const uuid = Object.keys(groups).find(
    (key) => typeof groups[key] === "object" && groups[key].path === TARGET,
  );
  if (!uuid) throw new Error(`${TARGET} group is missing`);
  giveGroupOwnFiles(project, uuid);
}

/** Expo accepts multiple app aliases, but a share extension can open only one URI scheme. */
function primaryShareScheme(config, platform) {
  const fallback = platform === "android" ? config.android?.package : config.ios?.bundleIdentifier;
  const configured =
    config.scheme === undefined
      ? fallback
      : Array.isArray(config.scheme)
        ? config.scheme[0]
        : config.scheme;
  if (typeof configured !== "string" || !/^[a-z][a-z\d+.-]*$/i.test(configured)) {
    throw new Error("The share extension requires a valid primary app URL scheme.");
  }
  return configured;
}

function configureShareExtensionInfo(infoPlist, name, scheme) {
  const contents = plist.parse(renameShareExtension(infoPlist, name));
  if (
    !contents ||
    typeof contents !== "object" ||
    !Object.hasOwn(contents, "MainTargetUrlScheme")
  ) {
    throw new Error(`${TARGET} Info.plist has no app URL scheme`);
  }
  contents.MainTargetUrlScheme = scheme;
  return plist.build(contents);
}

/**
 * Fixes generated share-extension metadata and iOS file references. List before `expo-sharing`:
 * mods run in reverse order, so its project mod then runs after expo-sharing adds the target.
 * The extension's Info.plist comes from a dangerous mod, which runs before every other mod.
 */
function withShareExtension(config) {
  config = withStringsXml(config, (config) => {
    // Replacing the entire entry also removes malformed XML spans from previous array values.
    config.modResults.resources.string = (config.modResults.resources.string ?? []).filter(
      (item) => item.$?.name !== "share_into_scheme",
    );
    config.modResults = AndroidConfig.Strings.setStringItem(
      [
        AndroidConfig.Resources.buildResourceItem({
          name: "share_into_scheme",
          value: primaryShareScheme(config, "android"),
          translatable: false,
        }),
      ],
      config.modResults,
    );
    return config;
  });
  config = withXcodeProject(config, (config) => {
    separateShareExtensionFiles(config.modResults);
    return config;
  });
  return withFinalizedMod(config, [
    "ios",
    (config) => {
      // expo-sharing names the extension after its target, "expo-sharing-extension".
      const file = path.join(config.modRequest.platformProjectRoot, TARGET, "Info.plist");
      fs.writeFileSync(
        file,
        configureShareExtensionInfo(
          fs.readFileSync(file, "utf8"),
          config.name,
          primaryShareScheme(config, "ios"),
        ),
      );
      return config;
    },
  ]);
}

module.exports = withShareExtension;
module.exports.renameShareExtension = renameShareExtension;
module.exports.separateShareExtensionFiles = separateShareExtensionFiles;
