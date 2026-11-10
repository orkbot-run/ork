// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// Keep failed writes and removals for the lifetime of this window, including if the
// browser later lets reads succeed. This avoids reviving an older value mid-session.
const shadows = new WeakMap<object, Map<string, string | null>>();

function shadow() {
  const owner = typeof window === "undefined" ? globalThis : window;
  let values = shadows.get(owner);
  if (!values) {
    values = new Map();
    shadows.set(owner, values);
  }
  return values;
}

function nativeStorage(): Storage | undefined {
  return typeof window === "undefined"
    ? globalThis.localStorage
    : (window.localStorage ?? globalThis.localStorage);
}

export const safeLocalStorage = {
  getItem(key: string): string | null {
    const values = shadow();
    if (values.has(key)) return values.get(key) ?? null;
    try {
      return nativeStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    const values = shadow();
    try {
      const storage = nativeStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(key, value);
      if (storage.getItem(key) === value) values.delete(key);
      else values.set(key, value);
    } catch {
      values.set(key, value);
    }
  },
  removeItem(key: string): boolean {
    const values = shadow();
    try {
      const storage = nativeStorage();
      if (!storage) throw new Error("Storage unavailable");
      storage.removeItem(key);
      if (storage.getItem(key) === null) {
        values.delete(key);
        return true;
      }
      values.set(key, null);
      return false;
    } catch {
      values.set(key, null);
      return false;
    }
  },
};
