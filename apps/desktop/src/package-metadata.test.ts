// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// Modified by Ork contributors to verify Tauri bundle metadata.
// Inherited material remains Apache-2.0. New changes follow LICENSE.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const bundle = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
  productName: string;
  identifier: string;
  bundle: {
    resources: Record<string, string>;
  };
};
const info = readFileSync(path.join(root, "src-tauri/Info.plist"), "utf8");

describe("desktop bundle metadata", () => {
  it("uses the Ork name and preserves the installed Tauri application identifier", () => {
    expect(bundle.productName).toBe("Ork");
    expect(bundle.identifier).toBe("run.orkbot.desktop.preview");
  });

  it.each(["es", "pl"])("ships a %s version of every macOS permission prompt", (locale) => {
    const strings = readFileSync(
      path.join(root, `assets/${locale}.lproj/InfoPlist.strings`),
      "utf8",
    );
    const prompts = [...info.matchAll(/<key>([^<]*UsageDescription)<\/key>/g)].map(
      (match) => match[1],
    );
    expect(prompts.length).toBeGreaterThan(0);
    for (const key of prompts) expect(strings, key).toMatch(new RegExp(`^"${key}" = ".+";$`, "m"));
    expect(bundle.bundle.resources[`../assets/${locale}.lproj`]).toBe(`${locale}.lproj`);
  });
});
