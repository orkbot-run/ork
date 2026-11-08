// SPDX-FileCopyrightText: 2026 Rakazo contributors
// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// Inherited preference handling remains Apache-2.0; Ork changes share storage behavior.

/** Platform storage and change events stay with the native/browser adapter. */
export function createPersistedPreference<T extends string | boolean>(options: {
  normalize: (raw: string | null | undefined) => T;
  serialize?: (value: T) => string;
  read?: () => string | null;
  write?: (serialized: string) => boolean;
  listen?: (changed: (raw: string | null) => void) => (() => void) | undefined;
}) {
  let value: T | undefined;
  let revision = 0;
  let reading = 0;
  let unsaved = false;
  let disconnect: (() => void) | undefined;
  let writing = Promise.resolve();
  const listeners = new Set<() => void>();
  const serialize = options.serialize ?? String;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const read = (storage = options.read, normalize = options.normalize): T => {
    try {
      return normalize(storage?.() ?? null);
    } catch {
      return normalize(null);
    }
  };
  const get = (storage = options.read, normalize = options.normalize): T =>
    value === undefined ? read(storage, normalize) : value;
  const persist = (next: T, write = options.write): boolean => {
    try {
      return write?.(serialize(next)) === true;
    } catch {
      return false;
    }
  };
  const update = (next: T) => {
    revision++;
    value = next;
    notify();
    return next;
  };
  return {
    read,
    get,
    /** Some preferences intentionally cache their first device-derived default. */
    initialize(storage = options.read, normalize = options.normalize): T {
      if (value === undefined) value = read(storage, normalize);
      return value;
    },
    persist,
    set(next: T, write = options.write): T {
      revision++;
      value = next;
      unsaved = !persist(next, write);
      notify();
      return next;
    },
    async load(storage: () => Promise<string | null>): Promise<T> {
      const current = revision;
      const request = ++reading;
      await writing;
      if (current !== revision || request !== reading) return get();
      if (unsaved) return get();
      try {
        const raw = await storage();
        if (current === revision && request === reading) value = options.normalize(raw);
      } catch {
        if (current === revision && request === reading && value === undefined)
          value = options.normalize(null);
      }
      if (current === revision && request === reading) notify();
      return get();
    },
    async save(next: T, storage: (serialized: string) => Promise<void>): Promise<T> {
      const current = ++revision;
      value = next;
      unsaved = true;
      // Admit this immutable write before notifying a subscriber that may choose again.
      const pending = writing
        .then(async () => {
          await storage(serialize(next));
          if (current === revision) unsaved = false;
        })
        .catch(() => undefined);
      writing = pending;
      notify();
      await pending;
      return next;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1 && options.listen) {
        disconnect = options.listen((raw) => {
          unsaved = false;
          update(options.normalize(raw));
        });
        // Catch changes made while no window consumer was subscribed. A failed local write
        // remains an in-memory choice until an actual external change replaces it.
        if (disconnect && !unsaved && options.read) {
          try {
            const previous = get();
            const next = options.normalize(options.read());
            value = next;
            if (!Object.is(previous, next)) notify();
          } catch {
            // Unreadable storage must not erase the current in-memory choice.
          }
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disconnect?.();
          disconnect = undefined;
        }
      };
    },
  };
}
