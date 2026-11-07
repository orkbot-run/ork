// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

let scope = "";
let revision = 0;
let writes: Promise<void> = Promise.resolve();
let writeNative: (scope: string) => Promise<void> = async () => undefined;

export function configureNotificationSessionWriter(write: (scope: string) => Promise<void>): void {
  writeNative = write;
}

/** Missing scope from an older server fails closed; this identifier never grants access. */
export function setNotificationSessionScope(value: unknown, current: () => boolean): Promise<void> {
  if (!current()) return Promise.resolve();
  scope = typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : "";
  const captured = scope;
  const owner = ++revision;
  writes = writes
    .catch(() => undefined)
    .then(async () => {
      if (owner === revision && current()) await writeNative(captured);
    });
  return writes;
}

export function clearNotificationSessionScope(): Promise<void> {
  return setNotificationSessionScope("", () => true);
}

export function matchesNotificationSession(value: unknown): boolean {
  return scope !== "" && value === scope;
}
