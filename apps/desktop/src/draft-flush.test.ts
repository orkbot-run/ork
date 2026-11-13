// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src-tauri/src/document.rs", import.meta.url), "utf8");
const script = source.match(/const FLUSH_SCRIPT: &str = r#"([\s\S]*?)"#;/)![1]!;
const resumed = "window.orkbotResumeComposerDrafts?.(); delete window.__orkbotDraftFlush;";
it("permits legacy unmanaged pages without a hook and refuses missing managed hooks", () => {
  expect(vm.runInNewContext(script, { window: {}, required: false })).toBe("ready");
  expect(vm.runInNewContext(script, { window: {}, required: true })).toBe("failed");
});
it("starts one flush, reports only completion state and resets after resuming the original document", async () => {
  let finish!: () => void;
  const flush = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const resume = vi.fn();
  const context = vm.createContext({
    window: { orkbotFlushComposerDrafts: flush, orkbotResumeComposerDrafts: resume },
    required: true,
  });
  expect(vm.runInContext(script, context)).toBe("pending");
  expect(vm.runInContext(script, context)).toBe("pending");
  await Promise.resolve();
  expect(flush).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() => expect(vm.runInContext(script, context)).toBe("ready"));
  vm.runInContext(resumed, context);
  expect(resume).toHaveBeenCalledOnce();
  expect(vm.runInContext(script, context)).toBe("pending");
});
it("returns no exception details and cannot let a retired completion finish a replacement attempt", async () => {
  let finish!: () => void;
  const window = {
    orkbotFlushComposerDrafts: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  };
  const context = vm.createContext({ window, required: true });
  expect(vm.runInContext(script, context)).toBe("pending");
  await Promise.resolve();
  const old = finish;
  vm.runInContext(resumed, context);
  expect(vm.runInContext(script, context)).toBe("pending");
  await Promise.resolve();
  old();
  await Promise.resolve();
  await Promise.resolve();
  expect(vm.runInContext(script, context)).toBe("pending");
  vm.runInContext(resumed, context);
  window.orkbotFlushComposerDrafts = () => Promise.reject(new Error("sensitive fixture detail"));
  expect(vm.runInContext(script, context)).toBe("pending");
  await vi.waitFor(() => expect(vm.runInContext(script, context)).toBe("failed"));
});
