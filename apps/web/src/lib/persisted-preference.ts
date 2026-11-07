// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited preference handling remains Apache-2.0; Ork changes share storage behavior.

import { createPersistedPreference } from "@orkbot/core";

export function preferenceStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Only localStorage changes for this preference (or a clear) belong to this store. */
export function browserPreference<T extends string | boolean>(
  key: string,
  normalize: (raw: string | null | undefined) => T,
  serialize?: (value: T) => string,
) {
  const read = () => {
    const storage = preferenceStorage();
    if (!storage) throw new Error("Preference storage unavailable");
    return storage.getItem(key);
  };
  return createPersistedPreference({
    normalize,
    serialize,
    read,
    write: (serialized) => {
      const storage = preferenceStorage();
      if (!storage) return false;
      storage.setItem(key, serialized);
      return true;
    },
    listen: (changed) => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
      const handler = (event: StorageEvent) => {
        if (event.key !== null && event.key !== key) return;
        if (event.storageArea !== null && event.storageArea !== preferenceStorage()) return;
        try {
          // An older queued event must not undo a newer write in this window.
          changed(read());
        } catch {
          // Unavailable storage must not replace a choice already held in memory.
        }
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  });
}
