// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited Apache-2.0 material is preserved; source-owned composer recovery is an Ork addition.

// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationSnapshot } from "../../lib/dictation";
import { dictation } from "../../lib/dictation";
import {
  HoldToTalkControls,
  HoldToTalkStrip,
  LOCK_DISTANCE_PX,
  TAP_MS,
  useHoldToTalk,
} from "./HoldToTalk";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const watchers = new Set<(snapshot: DictationSnapshot) => void>();
let onFinal: ((text: string) => void) | null = null;
let transcript = "";
let latestSnapshot: DictationSnapshot = { status: "idle", transcript: "" };

function emit(snapshot: DictationSnapshot) {
  latestSnapshot = snapshot;
  for (const watcher of [...watchers]) watcher(snapshot);
}

vi.mock("../../lib/dictation", () => {
  const instance = {
    get state() {
      return latestSnapshot;
    },
    subscribe: vi.fn((watcher: (snapshot: DictationSnapshot) => void) => {
      watchers.add(watcher);
      watcher({ status: "idle", transcript: "" });
      return () => watchers.delete(watcher);
    }),
    listen: vi.fn(async (opts: { onFinal: (text: string) => void }) => {
      onFinal = opts.onFinal;
      emit({ status: "listening", transcript: "" });
    }),
    submitHold: vi.fn(() => {
      const final = onFinal;
      onFinal = null;
      emit({ status: "idle", transcript: "" });
      if (transcript) final?.(transcript);
    }),
    stop: vi.fn(() => {
      onFinal = null;
      emit({ status: "idle", transcript: "" });
    }),
  };
  return {
    dictation: instance,
    Dictation: class {
      get state() {
        return instance.state;
      }
      subscribe = instance.subscribe;
      listen = instance.listen;
      submitHold = instance.submitHold;
      stop = instance.stop;
    },
  };
});

function Harness({ onText }: { onText: (text: string) => void }) {
  const talk = useHoldToTalk({ transcribe: false, onText });
  return (
    <div>
      <HoldToTalkStrip talk={talk} />
      <HoldToTalkControls talk={talk} />
    </div>
  );
}

describe("hold to talk", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const onText = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    transcript = "";
    latestSnapshot = { status: "idle", transcript: "" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness onText={onText} />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    watchers.clear();
    vi.useRealTimers();
  });

  function button(name: string) {
    const found = container?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    if (!found) throw new Error(`Missing button: ${name}`);
    return found;
  }

  function pointer(target: Element, type: string, clientY = 400) {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientY }));
    });
  }

  function heard(text: string) {
    transcript = text;
    act(() => emit({ status: "listening", transcript: text }));
  }

  it("sends what was said when the hold is released", () => {
    const mic = button("Hold to talk");
    pointer(mic, "pointerdown");
    expect(dictation.listen).toHaveBeenCalledWith(expect.objectContaining({ mode: "hold" }));
    heard("buy milk tomorrow");
    expect(container?.textContent).toContain("buy milk tomorrow");

    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup");

    expect(dictation.submitHold).toHaveBeenCalledOnce();
    expect(onText).toHaveBeenCalledWith("buy milk tomorrow");
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("treats a quick tap as a tap: nothing is sent and the hint shows", () => {
    const mic = button("Hold to talk");
    pointer(mic, "pointerdown");
    pointer(mic, "pointerup");

    expect(dictation.submitHold).not.toHaveBeenCalled();
    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(onText).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Hold to talk, release to send");
  });

  it("locks when the hold slides up, then sends only on Send", () => {
    const mic = button("Hold to talk");
    pointer(mic, "pointerdown", 400);
    pointer(mic, "pointermove", 400 - LOCK_DISTANCE_PX - 1);
    heard("call the plumber");
    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup", 400 - LOCK_DISTANCE_PX - 1);

    expect(dictation.submitHold).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("call the plumber");

    act(() => button("Send recording").click());
    expect(onText).toHaveBeenCalledWith("call the plumber");
  });

  it("discards a locked recording", () => {
    const mic = button("Hold to talk");
    pointer(mic, "pointerdown", 400);
    pointer(mic, "pointermove", 400 - LOCK_DISTANCE_PX - 1);
    heard("never mind");

    act(() => button("Discard recording").click());

    expect(dictation.stop).toHaveBeenCalledWith("cancel");
    expect(onText).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("keeps a dispatched transcription alive on unmount, while cancelling an active microphone", () => {
    pointer(button("Hold to talk"), "pointerdown", 400);
    act(() => emit({ status: "transcribing", transcript: "" }));
    vi.mocked(dictation.stop).mockClear();
    act(() => root?.unmount());
    root = undefined;
    expect(dictation.stop).not.toHaveBeenCalled();
  });

  it("keeps the recording's original callback when the component rerenders", () => {
    pointer(button("Hold to talk"), "pointerdown", 400);
    const sourceFinal = onFinal!;
    const replacement = vi.fn();
    act(() => root?.render(<Harness onText={replacement} />));
    act(() => sourceFinal("original source"));
    expect(onText).toHaveBeenCalledWith("original source");
    expect(replacement).not.toHaveBeenCalled();
  });

  it("starts locked from the keyboard, since a key cannot be held and slid", () => {
    act(() => {
      button("Hold to talk").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });

    expect(dictation.listen).toHaveBeenCalledOnce();
    expect(button("Send recording")).toBeTruthy();
  });

  it("keeps the solid red under the held pointer in both themes", () => {
    const mic = button("Hold to talk");
    pointer(mic, "pointerdown");
    const classes = mic.className.split(" ");

    // The pointer hovers the button for the whole hold, so the outline hover colours
    // (a grey fill in dark, dark text) must give way to the recording colours.
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-destructive-fill",
        "hover:bg-destructive-fill",
        "dark:hover:bg-destructive-fill",
        "text-destructive-foreground",
        "hover:text-destructive-foreground",
      ]),
    );
    expect(classes).not.toContain("dark:hover:bg-input/50");
    expect(classes).not.toContain("hover:text-foreground");
  });
});
