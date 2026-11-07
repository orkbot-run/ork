// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 behavior is preserved; portable cwd mapping follows LICENSE.md.

import { describe, expect, it } from "vitest";
import {
  displayBotWorkspacePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  resolveWorkspaceCwd,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";

describe("portable command cwd", () => {
  it.each([undefined, "", ".", "/", "~", "~/", "/home/orkbot", "/home/orkbot/"])(
    "uses the workspace root for %s",
    (cwd) => {
      expect(resolveWorkspaceCwd("/home/orkbot", cwd)).toBe("/home/orkbot");
    },
  );

  it.each([
    "notes/二",
    "/notes/二",
    "~/notes/二",
    "/home/orkbot/notes/二",
    String.raw`\home\orkbot\notes\二`,
  ])("maps equivalent workspace child spellings: %s", (cwd) => {
    expect(resolveWorkspaceCwd("/home/orkbot", cwd)).toBe("/home/orkbot/notes/二");
  });

  it("uses the longest complete alias boundary and retains provider-native output roots", () => {
    expect(
      resolveWorkspaceCwd("orkbot-home", "/home/user/orkbot-home/notes", [
        "/home/user",
        "/home/user/orkbot-home",
      ]),
    ).toBe("orkbot-home/notes");
    expect(resolveWorkspaceCwd("/root", "/home/user-else/notes", ["/home/user"])).toBe(
      "/root/home/user-else/notes",
    );
    expect(resolveWorkspaceCwd("orkbot-home", "orkbot-home")).toBe("orkbot-home/orkbot-home");
    expect(resolveWorkspaceCwd("", "/home/orkbot/notes", ["/home/orkbot"])).toBe("notes");
  });

  it.each([
    "..",
    "notes/../outside",
    "./notes",
    "~/../outside",
    "/home/orkbot/../outside",
    String.raw`\home\orkbot\notes\..\outside`,
    "notes\0hidden",
    "C:/outside",
    String.raw`C:\outside`,
    "C:outside",
    String.raw`\\server\share`,
    "//server/share",
  ])("rejects traversal or foreign native paths before normalization: %s", (cwd) => {
    expect(() => resolveWorkspaceCwd("/home/orkbot", cwd)).toThrow(
      "Path escapes the computer workspace",
    );
  });
});

describe("Team Computer bot folders", () => {
  it("uses the bot folder for relative paths and cwd", () => {
    expect(teamBotWorkspaceDirectory("bot-1")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "projects/site")).toBe(
      "bots/bot-1/projects/site",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", "/Users/me/project")).toBe("/Users/me/project");
  });

  it("preserves Windows absolute working directories even when the backend runs on Linux", () => {
    const drive = String.raw`C:\Users\example\project`;
    const share = String.raw`\\server\share\project`;
    expect(resolveBotWorkspaceCwd("team", "bot-1", drive)).toBe(drive);
    expect(resolveBotWorkspaceCwd("team", "bot-1", share)).toBe(share);
  });

  it("keeps shared, bot-root, and absolute paths at the Team root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "bots/bot-2/result.md")).toBe(
      "bots/bot-2/result.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/root-note.md")).toBe("root-note.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/shared/brief.md")).toBe("shared/brief.md");
  });

  it("treats a leading ~ as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "~")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~\\notes\\x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "~/notes/x.md")).toBe("/notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~x/y")).toBe("bots/bot-1/~x/y");
    expect(() => resolveBotWorkspacePath("team", "bot-1", "~/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under ~", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "~/bots", "bots/bot-1")).toBe("bots/bot-1");
  });

  it("treats a leading /home/orkbot as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/orkbot")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/orkbot/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", String.raw`\home\orkbot\notes\x.md`)).toBe(
      "notes/x.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/orkbot/shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/orkbot/notes/x.md")).toBe(
      "/notes/x.md",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/orkbot")).toBe("/");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", String.raw`\home\orkbot\notes\x.md`)).toBe(
      String.raw`\notes\x.md`,
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/orkbottest/file.txt")).toBe(
      "home/orkbottest/file.txt",
    );
    expect(() => resolveBotWorkspacePath("team", "bot-1", "/home/orkbot/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under /home/orkbot", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "/home/orkbot/bots", "bots/bot-1")).toBe(
      "bots/bot-1",
    );
  });

  it("presents the current bot folder as its home without hiding Team paths", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "notes", "bots/bot-1/notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "shared", "shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "bots", "bots/bot-1")).toBe("bots/bot-1");
    expect(displayBotWorkspacePath("team", "bot-1", "/", "bots/bot-1")).toBe("bots/bot-1");
    expect(
      displayBotWorkspacePath("team", "bot-1", "bots/bot-1", "bots/bot-1/notes/result.txt"),
    ).toBe("bots/bot-1/notes/result.txt");
  });

  it("leaves Private Computer paths unchanged", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(resolveBotWorkspaceCwd("dedicated", "bot-1", undefined)).toBeUndefined();
    expect(displayBotWorkspacePath("dedicated", "bot-1", "notes", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });
});

describe("resolveBotUploadPath", () => {
  it("keeps team uploads in the controlling bot home or shared", () => {
    expect(resolveBotUploadPath("team", "bot-1", "notes.txt")).toBe("bots/bot-1/notes.txt");
    expect(resolveBotUploadPath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(() => resolveBotUploadPath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(
      /escapes the bot workspace/,
    );
  });
});
