// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited keyboard tests are preserved. Native HTTP input coverage follows LICENSE.md.

import { describe, expect, it } from "vitest";
import {
  COMPUTER_KEYBOARD_READY_MESSAGE,
  commandsForKeyboardChange,
  computerKeyboardChanges,
  computerKeyboardInputs,
  computerKeyboardReadyProbe,
  computerKeyboardScript,
  createComputerKeyboardBridge,
  isComputerKeyboardReadyMessage,
} from "./computer-keyboard";

describe("computer keyboard edits", () => {
  it("translates typed and deleted text at the end", () => {
    expect(computerKeyboardChanges("", "4")).toEqual({ backspaces: 0, text: "4" });
    expect(computerKeyboardChanges("4", "48")).toEqual({ backspaces: 0, text: "8" });
    expect(computerKeyboardChanges("48", "4")).toEqual({ backspaces: 1, text: "" });
    expect(computerKeyboardChanges("abc", "")).toEqual({ backspaces: 3, text: "" });
  });

  it("finds nothing new in a repeated change", () => {
    expect(computerKeyboardChanges("44", "44")).toEqual({ backspaces: 0, text: "" });
    expect(commandsForKeyboardChange({ backspaces: 0, text: "" }, true)).toEqual([]);
  });

  it("counts characters outside the basic plane once", () => {
    expect(computerKeyboardChanges("a", "a😀")).toEqual({ backspaces: 0, text: "😀" });
    expect(computerKeyboardChanges("a😀", "a")).toEqual({ backspaces: 1, text: "" });
    expect(computerKeyboardChanges("שלו", "שלום")).toEqual({ backspaces: 0, text: "ם" });
  });

  it("ignores a change anywhere but the end", () => {
    expect(computerKeyboardChanges("recieve", "receive")).toEqual({ backspaces: 0, text: "" });
    expect(computerKeyboardChanges("482", "4182")).toEqual({ backspaces: 0, text: "" });
    expect(computerKeyboardChanges("482", "42")).toEqual({ backspaces: 0, text: "" });
  });

  it("keeps a return between the characters on either side", () => {
    expect(commandsForKeyboardChange(computerKeyboardChanges("", "a\nb"), false)).toEqual([
      { type: "text", text: "a" },
      { type: "key", name: "Return" },
      { type: "text", text: "b" },
    ]);
    expect(commandsForKeyboardChange(computerKeyboardChanges("", "a\r\nb"), false)).toEqual([
      { type: "text", text: "a" },
      { type: "key", name: "Return" },
      { type: "text", text: "b" },
    ]);
  });

  it("sends Ctrl as a chord on only the next key", () => {
    expect(commandsForKeyboardChange({ backspaces: 0, text: "c" }, true)).toEqual([
      { type: "char", text: "c", control: true },
    ]);
    expect(commandsForKeyboardChange({ backspaces: 0, text: "cd" }, true)).toEqual([
      { type: "char", text: "c", control: true },
      { type: "text", text: "d" },
    ]);
    expect(commandsForKeyboardChange({ backspaces: 2, text: "e" }, true)).toEqual([
      { type: "key", name: "Backspace", control: true },
      { type: "backspace", count: 1 },
      { type: "text", text: "e" },
    ]);
    expect(commandsForKeyboardChange({ backspaces: 0, text: "\nb" }, true)).toEqual([
      { type: "key", name: "Return", control: true },
      { type: "text", text: "b" },
    ]);
    expect(commandsForKeyboardChange({ backspaces: 2, text: "" }, false)).toEqual([
      { type: "backspace", count: 2 },
    ]);
  });

  it("embeds commands as JSON that cannot break out of the injected call", () => {
    const script = computerKeyboardScript({
      type: "text",
      text: '</script>\u2028");alert(1)',
    });
    expect(script.startsWith("window.orkbotComputerKeyboard?.run(")).toBe(true);
    expect(script.endsWith(");true;")).toBe(true);
    const json = script.slice("window.orkbotComputerKeyboard?.run(".length, -");true;".length);
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual({ type: "text", text: '</script>\u2028");alert(1)' });
  });

  it("queues commands until the screen keyboard bridge is ready", () => {
    const bridge = createComputerKeyboardBridge();
    const text = { type: "text" as const, text: "a" };
    const enter = { type: "key" as const, name: "Return" as const };
    expect(bridge.push(text)).toEqual([]);
    expect(bridge.push(enter)).toEqual([]);
    expect(bridge.ready()).toEqual([text, enter]);
    expect(bridge.isReady()).toBe(true);
    expect(bridge.push(text)).toEqual([text]);
    expect(bridge.ready()).toEqual([]);
    const nextBridge = createComputerKeyboardBridge();
    expect(nextBridge.isReady()).toBe(false);
    expect(nextBridge.push(enter)).toEqual([]);
    expect(nextBridge.ready()).toEqual([enter]);
  });

  it("asks the screen page to report when the keyboard bridge exists", () => {
    const script = computerKeyboardReadyProbe('1"</script>');
    expect(script.endsWith(";true;")).toBe(true);
    expect(script).toContain("window.orkbotComputerKeyboard");
    expect(script).toContain("ReactNativeWebView.postMessage");
    expect(script).not.toContain("<");
    const literal = script.slice(
      script.indexOf("postMessage(") + "postMessage(".length,
      script.indexOf(");return"),
    );
    expect(JSON.parse(literal)).toBe(`${COMPUTER_KEYBOARD_READY_MESSAGE}:1"</script>`);
    expect(isComputerKeyboardReadyMessage(`${COMPUTER_KEYBOARD_READY_MESSAGE}:4`, "4")).toBe(true);
    expect(isComputerKeyboardReadyMessage(`${COMPUTER_KEYBOARD_READY_MESSAGE}:4`, "5")).toBe(false);
  });
});

describe("native HTTP keyboard input", () => {
  it("preserves Unicode text and maps control chords and special keys", () => {
    expect([...computerKeyboardInputs({ type: "text", text: "Hello 👋" })]).toEqual([
      { kind: "clipboard", payload: { text: "Hello 👋" } },
    ]);
    expect([...computerKeyboardInputs({ type: "key", name: "ArrowLeft", control: true })]).toEqual([
      { kind: "key", payload: { key: "ctrl+Left" } },
    ]);
    expect([...computerKeyboardInputs({ type: "char", text: "a", control: true })]).toEqual([
      { kind: "key", payload: { key: "ctrl+a" } },
    ]);
    expect([...computerKeyboardInputs({ type: "key", name: "Return" })]).toEqual([
      { kind: "key", payload: { key: "Return" } },
    ]);
    expect([...computerKeyboardInputs({ type: "backspace", count: 2 })]).toEqual([
      { kind: "key", payload: { key: "BackSpace" } },
      { kind: "key", payload: { key: "BackSpace" } },
    ]);
  });
});
