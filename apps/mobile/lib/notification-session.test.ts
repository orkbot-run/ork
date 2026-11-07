// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors

import { beforeEach, expect, it, vi } from "vitest";
import {
  clearNotificationSessionScope,
  configureNotificationSessionWriter,
  matchesNotificationSession,
  setNotificationSessionScope,
} from "./notification-session";

beforeEach(async () => {
  configureNotificationSessionWriter(async () => undefined);
  await clearNotificationSessionScope();
});

it("accepts only the current session's delivery scope, including after account changes", async () => {
  const first = "a".repeat(64);
  const second = "b".repeat(64);
  await setNotificationSessionScope(first, () => true);
  expect(matchesNotificationSession(first)).toBe(true);
  await clearNotificationSessionScope();
  expect(matchesNotificationSession(first)).toBe(false);
  await setNotificationSessionScope(second, () => true);
  expect(matchesNotificationSession(first)).toBe(false);
  expect(matchesNotificationSession(second)).toBe(true);
  await setNotificationSessionScope(first, () => false);
  expect(matchesNotificationSession(second)).toBe(true);
  await setNotificationSessionScope(undefined, () => true);
  expect(matchesNotificationSession(second)).toBe(false);
});

it("serializes native updates so a delayed old write cannot follow logout", async () => {
  let release!: () => void;
  const write = vi.fn(async () => {});
  write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  configureNotificationSessionWriter(write);
  const first = setNotificationSessionScope("a".repeat(64), () => true);
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  const logout = clearNotificationSessionScope();
  expect(matchesNotificationSession("a".repeat(64))).toBe(false);
  release();
  await Promise.all([first, logout]);
  expect(write.mock.calls).toEqual([["a".repeat(64)], [""]]);
});
