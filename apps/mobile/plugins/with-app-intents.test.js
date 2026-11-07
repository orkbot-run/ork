// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited Rakazo tests remain Apache-2.0; Ork shortcut verification tests are PolyForm-covered.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const mobile = join(import.meta.dirname, "..");
const read = (file) => readFileSync(join(mobile, file), "utf8");
const constant = (file, name) => read(file).match(new RegExp(`${name} = "([^"]+)"`))?.[1];

describe("OrkIntents", () => {
  // The intents read what the app saved; renaming a key on one side would break them silently.
  it("reads the secure-store keys the app writes", () => {
    const swift = read("ios-intents/OrkIntents.swift");
    for (const [file, name] of [
      ["lib/session.ts", "SESSION_KEY"],
      ["lib/server-config.ts", "API_BASE_STORAGE_KEY"],
      ["lib/api.ts", "SPACE_KEY"],
      ["lib/last-bot.ts", "LAST_BOT_KEY"],
      ["lib/server-headers.ts", "SERVER_HEADERS_KEY"],
    ]) {
      const key = constant(file, name);
      expect(key, `${name} in ${file}`).toBeTruthy();
      expect(swift).toContain(`secureStoreItem("${key}")`);
    }
  });

  it("hands a voice chat to the module that reads it", () => {
    const swift = read("ios-intents/OrkIntents.swift");
    const module = read("modules/orkbot-voice-chat/ios/OrkVoiceChatModule.swift");
    expect(swift).toContain('"orkbot.pending_voice_chat"');
    expect(module).toContain('"orkbot.pending_voice_chat"');
    for (const source of [swift, module]) {
      expect(source).toContain('Notification.Name("OrkPendingVoiceChat")');
    }
  });

  it("falls back to the app's own default server", () => {
    const local = constant("lib/server-config.ts", "LOCAL_API");
    expect(read("plugins/with-app-intents.js")).toContain(`"${local}"`);
  });
});

describe("withAppIntents prebuild", () => {
  it("refreshes the sources without duplicating their build references", () => {
    const files = new Set();
    const copied = [];
    const added = [];
    const widgetSettings = { PRODUCT_NAME: '"OrkWidgets"' };
    const config = {
      version: "2.0.0",
      ios: { bundleIdentifier: "com.example.app", buildNumber: "7" },
      modRequest: { projectRoot: "/project", platformProjectRoot: "/project/ios" },
      modResults: {
        hasFile: (file) => files.has(file),
        pbxTargetByName: (name) => (name === "OrkWidgets" ? {} : undefined),
        pbxXCBuildConfigurationSection: () => ({ widget: { buildSettings: widgetSettings } }),
      },
    };
    const plist = { modResults: { UIBackgroundModes: ["audio"] } };
    const module = { exports: {} };
    runInNewContext(read("plugins/with-app-intents.js"), {
      module,
      __dirname: join(mobile, "plugins"),
      process: { env: { EXPO_PUBLIC_API_URL: "https://api.example.test" } },
      require: (name) => {
        if (name === "node:fs")
          return {
            copyFileSync: (...args) => copied.push(args),
            cpSync: (...args) => copied.push(args.slice(0, 2)),
          };
        if (name === "node:path") return { join };
        if (name === "./pbx-group") return createRequire(import.meta.url)("./pbx-group.js");
        if (name === "expo/config-plugins")
          return {
            withInfoPlist: (value, mod) => {
              mod(plist);
              return value;
            },
            withXcodeProject: (value, mod) => mod(value),
            IOSConfig: {
              XcodeUtils: {
                getProjectName: () => "Ork",
                addBuildSourceFileToGroup: (input) => {
                  added.push(input);
                  files.add(input.filepath);
                },
              },
            },
          };
        throw new Error(`Unexpected module: ${name}`);
      },
    });
    module.exports(config);
    module.exports(config);
    expect(plist.modResults.OrkDefaultApiBase).toBe("https://api.example.test");
    expect(plist.modResults.UIBackgroundModes).toEqual(["audio"]);
    expect(copied).toContainEqual([
      join(mobile, "ios-intents/OrkIntents.swift"),
      "/project/ios/Ork/OrkIntents.swift",
    ]);
    expect(added.map((input) => input.filepath)).toEqual([
      "Ork/OrkIntents.swift",
      "Ork/ShortcutBotTarget.swift",
      "Ork/VoiceMessageRecorder.swift",
      "Ork/VoiceMessageActivity.swift",
    ]);
    expect(widgetSettings).toMatchObject({
      CURRENT_PROJECT_VERSION: "7",
      MARKETING_VERSION: "2.0.0",
    });
  });
});

describe("voice message Live Activity", () => {
  // EAS signs only the extensions app.json lists, under the bundle id the plugin gives them.
  it("lists the widget extension for EAS signing", () => {
    const app = JSON.parse(read("app.json")).expo;
    const [extension] = app.extra.eas.build.experimental.ios.appExtensions;
    expect(read("plugins/with-app-intents.js")).toContain(`"${extension.targetName}"`);
    expect(extension.bundleIdentifier).toBe(`${app.ios.bundleIdentifier}.widgets`);
  });
});

const hasSwift = spawnSync("swiftc", ["--version"], { encoding: "utf8" }).status === 0;

describe("shortcut target verification", () => {
  it.skipIf(!hasSwift)(
    "executes target and session failure boundaries in Swift",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "ork-shortcut-test-"));
      try {
        const executable = join(directory, "shortcut-target");
        execFileSync(
          "swiftc",
          [
            "-parse-as-library",
            join(mobile, "ios-intents/ShortcutBotTarget.swift"),
            join(mobile, "plugins/fixtures/ShortcutBotTarget.tests.swift"),
            "-o",
            executable,
          ],
          { encoding: "utf8", timeout: 60_000 },
        );
        expect(execFileSync(executable, [], { encoding: "utf8", timeout: 10_000 })).toContain(
          "20 shortcut target behaviors passed",
        );
        execFileSync(
          "swiftc",
          ["-frontend", "-parse", join(mobile, "ios-intents/OrkIntents.swift")],
          {
            encoding: "utf8",
            timeout: 30_000,
          },
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it("wires verification before voice handoff and retains typed storage failures", () => {
    const swift = read("ios-intents/OrkIntents.swift");
    expect(swift).toContain("try await resolveShortcutBot(");
    expect(swift).toContain("try await session.containsBot(candidate)");
    expect(swift).toContain('"bots/get", ["botId": target.botId]');
    expect(swift).toContain("statusCode == 404 { return false }");
    const voice = swift.slice(
      swift.indexOf("struct StartVoiceChatIntent"),
      swift.indexOf("private func target"),
    );
    expect(voice.indexOf("try await target(bot, with: session)")).toBeLessThan(
      voice.indexOf("UserDefaults.standard.set("),
    );
    expect(voice).toContain("try session.requireCurrent()");
    expect(swift).toContain("if status == errSecItemNotFound { continue }");
    expect(swift).toContain("guard status == errSecSuccess");
    expect(swift).not.toContain("try? OrkSession.load()");
    expect(swift).not.toContain("try? await session.currentUserId()");
  });
});
