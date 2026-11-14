// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Apache extension tests are preserved; share scheme regressions follow LICENSE.md.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { addNotificationExtension } from "./with-agent-notifications.js";
import { renameShareExtension, separateShareExtensionFiles } from "./with-share-extension.js";

const require = createRequire(import.meta.url);
const plugins = require.resolve("expo/config-plugins");
const { XML } = require(plugins);
const plist = createRequire(plugins)("@expo/plist").default;
const withShareExtension = require("./with-share-extension.js");
const {
  withShareIntoSchemeString,
} = require("expo-sharing/plugin/build/android/withShareIntoSchemeString");
const expoRoot = dirname(require.resolve("expo/package.json"));
const xcode = createRequire(require.resolve("@expo/config-plugins", { paths: [dirname(plugins)] }))(
  "xcode",
);
// The pinned expo-sharing prebuild code, so a change to its templates fails here.
const sharing = (file) => require(`expo-sharing/plugin/build/ios/${file}`);

function withTemplateProject(run) {
  const directory = mkdtempSync(join(tmpdir(), "orkbot-share-extension-"));
  try {
    const file = join(directory, "project.pbxproj");
    writeFileSync(
      file,
      execFileSync("tar", [
        "-xOf",
        join(expoRoot, "template.tgz"),
        "package/ios/HelloWorld.xcodeproj/project.pbxproj",
      ]),
    );
    const project = xcode.project(file);
    project.parseSync();
    run(project, directory, file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("names the pinned expo-sharing extension after the app", () => {
  withTemplateProject((_, directory) => {
    sharing("createInfoPlistFile").default(directory, "group.test.example", "example", {
      supportsText: true,
    });
    const original = readFileSync(join(directory, "Info.plist"), "utf8");
    expect(original).toContain("<string>$(PRODUCT_NAME)</string>");
    const renamed = renameShareExtension(original, "Ork");
    expect(renamed).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Ork<\/string>/);
    // The bundle name and everything else are untouched.
    expect(renamed.replace("Ork", "$(PRODUCT_NAME)")).toBe(original);
  });
});

it("keeps the share extension's Info.plist out of the other extensions' groups", () => {
  withTemplateProject((project, directory, file) => {
    // Mods run in reverse order, so the app's own extensions are already in the project.
    addNotificationExtension(project, directory, { ios: { bundleIdentifier: "test.example.app" } });
    const files = sharing("setupShareExtensionFiles").parseDirectoryFiles(
      dirname(
        require.resolve("expo-sharing/plugin/template-files/ios/ShareIntoViewController.swift"),
      ),
    );
    sharing("xcode/addPbxGroup").addPbxGroup(project, "expo-sharing-extension", files, directory);
    separateShareExtensionFiles(project);

    const groups = Object.values(project.hash.project.objects.PBXGroup).filter(
      (group) => typeof group === "object",
    );
    const members = new Map();
    for (const group of groups)
      for (const child of group.children ?? [])
        members.set(child.value, (members.get(child.value) ?? 0) + 1);
    const share = groups.find((group) => group.path === "expo-sharing-extension");
    const plist = share.children.find((child) => child.comment === "Info.plist");
    expect(members.get(plist.value)).toBe(1);
    writeFileSync(file, project.writeSync());
    expect(() => xcode.project(file).parseSync()).not.toThrow();
  });
});

it.each([{ scheme: "orkbot" }, { scheme: ["orkbot", "run.orkbot.app"] }])(
  "writes one Android share scheme while preserving registered app aliases: %j",
  async ({ scheme }) => {
    const registeredSchemes = Array.isArray(scheme) ? [...scheme] : scheme;
    const directory = mkdtempSync(join(tmpdir(), "ork-share-scheme-"));
    try {
      let config = withShareExtension({
        name: "Ork",
        slug: "ork",
        scheme,
        android: { package: "run.orkbot.app" },
        mods: { android: { strings: async (value) => value } },
      });
      // The real pinned plugin runs before our correction, matching Expo's reverse mod order.
      config = withShareIntoSchemeString(config, config.scheme);
      const result = await config.mods.android.strings({
        ...config,
        modResults: { resources: { string: [{ $: { name: "app_name" }, _: "Ork" }] } },
        modRequest: { platform: "android", modName: "strings" },
      });
      const file = join(directory, "strings.xml");
      await XML.writeXMLAsync({ path: file, xml: result.modResults });
      const written = readFileSync(file, "utf8");
      expect(written).toMatch(/name="share_into_scheme"[^>]*>orkbot<\/string>/);
      expect(written).not.toContain("<orkbot");
      expect(written).toContain('name="app_name">Ork</string>');
      expect(result.scheme).toEqual(registeredSchemes);
      expect(scheme).toEqual(registeredSchemes);
      expect(
        result.modResults.resources.string.filter((item) => item.$.name === "share_into_scheme"),
      ).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([{ scheme: "orkbot" }, { scheme: ["orkbot", "run.orkbot.app"] }])(
  "writes a String URL scheme in the real iOS share extension plist: %j",
  async ({ scheme }) => {
    const registeredSchemes = Array.isArray(scheme) ? [...scheme] : scheme;
    const directory = mkdtempSync(join(tmpdir(), "ork-share-plist-"));
    const extension = join(directory, "expo-sharing-extension");
    try {
      mkdirSync(extension);
      sharing("createInfoPlistFile").default(extension, "group.test.example", scheme, {
        supportsText: true,
      });
      const file = join(extension, "Info.plist");
      const before = plist.parse(readFileSync(file, "utf8"));
      const config = withShareExtension({
        name: "Ork",
        slug: "ork",
        scheme,
        ios: { bundleIdentifier: "test.example.app" },
        mods: { ios: { finalized: async (value) => value } },
      });
      const result = await config.mods.ios.finalized({
        ...config,
        modRequest: { platform: "ios", modName: "finalized", platformProjectRoot: directory },
      });
      expect(plist.parse(readFileSync(file, "utf8"))).toEqual({
        ...before,
        CFBundleDisplayName: "Ork",
        MainTargetUrlScheme: "orkbot",
      });
      expect(result.scheme).toEqual(registeredSchemes);
      expect(scheme).toEqual(registeredSchemes);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("replaces malformed previously generated Android share resources without retaining spans", async () => {
  const initial = {
    name: "Ork",
    slug: "ork",
    scheme: ["orkbot", "run.orkbot.app"],
    android: { package: "run.orkbot.app" },
  };
  const base = { ...initial, mods: { android: { strings: async (value) => value } } };
  const legacy = withShareIntoSchemeString(base, base.scheme);
  const request = { platform: "android", modName: "strings" };
  const old = await legacy.mods.android.strings({
    ...legacy,
    modResults: { resources: { string: [] } },
    modRequest: request,
  });
  const previous = await XML.parseXMLAsync(XML.format(old.modResults));
  expect(XML.format(previous)).toContain("<orkbot");
  let fixed = withShareExtension({
    ...initial,
    mods: { android: { strings: async (value) => value } },
  });
  fixed = withShareIntoSchemeString(fixed, fixed.scheme);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fixed.mods.android.strings({
      ...fixed,
      modResults: previous,
      modRequest: request,
    });
    const entries = result.modResults.resources.string.filter(
      (item) => item.$.name === "share_into_scheme",
    );
    expect(entries).toEqual([
      { $: { name: "share_into_scheme", translatable: "false" }, _: "orkbot" },
    ]);
    expect(XML.format(result.modResults)).not.toContain("<orkbot");
  }
});

it.each([{ scheme: "orkbot://" }, { scheme: ["orkbot,run.orkbot.app"] }, { scheme: [] }])(
  "rejects an invalid share URI scheme before writing native metadata: %j",
  async ({ scheme }) => {
    const config = withShareExtension({
      name: "Ork",
      slug: "ork",
      scheme,
      mods: { android: { strings: async (value) => value } },
    });
    await expect(
      config.mods.android.strings({
        ...config,
        modResults: { resources: { string: [] } },
        modRequest: { platform: "android", modName: "strings" },
      }),
    ).rejects.toThrow("valid primary app URL scheme");
  },
);
