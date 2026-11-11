// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { afterEach, expect, it, vi } from "vitest";
import { forgetSignedIn, hasSignedInBefore, rememberSignedIn } from "./returning-user";
import { safeLocalStorage } from "./storage";
import { persistUiLocale, resolveUiLocale } from "./ui-locale";

afterEach(() => vi.unstubAllGlobals());

it("keeps writes and removals when storage is inaccessible, even if reads recover", () => {
  let blocked = true;
  const items = new Map([["key", "old"]]);
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  };
  vi.stubGlobal("window", {
    get localStorage() {
      if (blocked) throw new Error("denied");
      return storage;
    },
  });
  safeLocalStorage.setItem("key", "new");
  expect(safeLocalStorage.getItem("key")).toBe("new");
  blocked = false;
  expect(safeLocalStorage.getItem("key")).toBe("new");
  blocked = true;
  expect(safeLocalStorage.removeItem("key")).toBe(false);
  blocked = false;
  expect(safeLocalStorage.getItem("key")).toBeNull();
  safeLocalStorage.setItem("key", "saved");
  expect(items.get("key")).toBe("saved");
  expect(safeLocalStorage.getItem("key")).toBe("saved");
});

it("retains locale and returning-user preferences for the session when the getter throws", () => {
  vi.stubGlobal("window", {
    get localStorage() {
      throw new Error("denied");
    },
  });
  expect(() => persistUiLocale("pl")).not.toThrow();
  expect(resolveUiLocale({ envDefault: null, navigatorLanguage: "en" })).toBe("pl");
  rememberSignedIn();
  expect(hasSignedInBefore()).toBe(true);
  forgetSignedIn();
  expect(hasSignedInBefore()).toBe(false);
});
