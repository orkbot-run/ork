// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 behavior is preserved; portable cwd mapping follows LICENSE.md.

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedDesktopPath,
  normalizeDesktopWorkspacePath,
  resolveDesktopCommandCwd,
} from "./desktop-sandbox-paths.js";

describe("desktop sandbox path rules", () => {
  it("maps portable cwd aliases while preserving explicitly allowed native host paths", () => {
    for (const cwd of [undefined, ".", "/", "~", "/home/orkbot", "/home/user"])
      expect(resolveDesktopCommandCwd("/private/work", cwd, [], "darwin")).toBe("/private/work");
    for (const cwd of ["notes", "~/notes", "/home/orkbot/notes", "/home/user/notes"])
      expect(resolveDesktopCommandCwd("/private/work", cwd, [], "darwin")).toBe(
        "/private/work/notes",
      );
    expect(
      resolveDesktopCommandCwd("/private/work", "/home/user/notes", ["/home/user"], "linux"),
    ).toBe("/home/user/notes");
    expect(
      resolveDesktopCommandCwd("/private/work", "/native/project", ["/native"], "darwin"),
    ).toBe("/native/project");
    expect(
      isAllowedDesktopPath(resolveDesktopCommandCwd("/private/work", "/etc", [], "darwin"), [
        "/private/work",
      ]),
    ).toBe(false);
    expect(() => resolveDesktopCommandCwd("/private/work", "../outside", [], "darwin")).toThrow(
      /escapes/,
    );
  });

  it("retains drive/UNC host containment and Windows reserved-name checks", () => {
    const home = String.raw`C:\work\bot`;
    expect(resolveDesktopCommandCwd(home, "/home/orkbot/notes", [], "win32")).toBe(
      String.raw`C:\work\bot\notes`,
    );
    expect(
      resolveDesktopCommandCwd(home, String.raw`D:\project`, [String.raw`D:\project`], "win32"),
    ).toBe(String.raw`D:\project`);
    expect(
      resolveDesktopCommandCwd(
        home,
        String.raw`\\server\share\project`,
        [String.raw`\\server\share`],
        "win32",
      ),
    ).toBe(String.raw`\\server\share\project`);
    for (const cwd of [
      "../outside",
      "NUL.txt",
      "notes:stream",
      "trailing.",
      String.raw`~\..\outside`,
    ])
      expect(() => resolveDesktopCommandCwd(home, cwd, [], "win32")).toThrow(/escapes/);
    expect(
      isAllowedDesktopPath(
        resolveDesktopCommandCwd(home, String.raw`D:\outside`, [], "win32"),
        [home],
        path.win32,
      ),
    ).toBe(false);
  });
  it("compares Windows roots case-insensitively without accepting siblings or other drives", () => {
    const roots = ["C:\\Users\\Owner\\Orkbot\\bot"];

    expect(
      isAllowedDesktopPath("c:\\users\\owner\\orkbot\\BOT\\notes.txt", roots, path.win32),
    ).toBe(true);
    expect(
      isAllowedDesktopPath("C:\\Users\\Owner\\Orkbot\\bot-other\\notes.txt", roots, path.win32),
    ).toBe(false);
    expect(isAllowedDesktopPath("D:\\notes.txt", roots, path.win32)).toBe(false);
  });

  it("handles explicitly allowed UNC roots without accepting sibling shares", () => {
    const roots = ["\\\\server\\share\\orkbot\\bot"];

    expect(
      isAllowedDesktopPath("\\\\SERVER\\share\\orkbot\\BOT\\notes.txt", roots, path.win32),
    ).toBe(true);
    expect(
      isAllowedDesktopPath("\\\\server\\share-other\\orkbot\\bot\\notes.txt", roots, path.win32),
    ).toBe(false);
  });

  it.each([
    "C:\\outside.txt",
    "C:outside.txt",
    "\\\\server\\share\\outside.txt",
    "\\\\?\\C:\\outside.txt",
    "notes.txt:secret",
    "NUL.txt",
    "COM1.log",
    "trailing-dot.",
    "trailing-space ",
  ])("rejects ambiguous or special Windows path %s", (requested) => {
    expect(() => normalizeDesktopWorkspacePath(requested, "win32")).toThrow(/escapes/i);
  });

  it("keeps ordinary portable paths and the virtual root syntax", () => {
    expect(normalizeDesktopWorkspacePath("/notes/result.txt", "win32")).toBe("notes/result.txt");
    expect(normalizeDesktopWorkspacePath("notes/result.txt", "linux")).toBe("notes/result.txt");
  });
});
