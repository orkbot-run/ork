// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("protects trusted documents without imposing the guard on separate OAuth documents", () => {
  const guard = readFileSync(new URL("../tauri-ui/prototype-guard.js", import.meta.url), "utf8");
  const trusted = vm.createContext({});
  const oauth = vm.createContext({});

  vm.runInContext(guard, trusted);
  expect(vm.runInContext("Object.isFrozen(Object.prototype)", trusted)).toBe(true);
  expect(() => vm.runInContext('"use strict"; ({}).toString = () => "test"', trusted)).toThrow();
  expect(vm.runInContext("Object.isFrozen(Object.prototype)", oauth)).toBe(false);
  expect(vm.runInContext('"use strict"; ({}).toString = () => "test"; true', oauth)).toBe(true);
});
