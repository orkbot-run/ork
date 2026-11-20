// SPDX-License-Identifier: Apache-2.0 AND PolyForm-Noncommercial-1.0.0
// SPDX-FileCopyrightText: 2026 Ork contributors (modifications)
// Inherited tests are preserved. Configurable threshold coverage follows LICENSE.md.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAgedStuckWork,
  isStuckWorkStatus,
  STUCK_WORK_EXPIRE_AFTER_MS,
  STUCK_WORK_NOTIFY_AFTER_MS,
  stuckWorkAction,
  stuckWorkDueAfterMs,
  stuckWorkReminder,
  stuckWorkStatusMessage,
  stuckWorkStatusMessages,
  stuckWorkStoppedNotification,
  stuckWorkThresholds,
  TAKEOVER_WAIT_EXPIRE_AFTER_MS,
} from "./stuck-work.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("stuck work thresholds", () => {
  it.each([
    undefined,
    "",
    " ",
    "bad",
    "60000ms",
    "-1",
    "0",
    "59999",
    "2592000001",
    "Infinity",
    "NaN",
    "60000.5",
    "0x10000",
  ])("uses defaults for missing or invalid values (%s)", (value) => {
    expect(
      stuckWorkThresholds({
        STUCK_WORK_NOTIFY_AFTER_MS: value,
        STUCK_WORK_EXPIRE_AFTER_MS: value,
      }),
    ).toEqual({
      notifyAfterMs: STUCK_WORK_NOTIFY_AFTER_MS,
      expireAfterMs: STUCK_WORK_EXPIRE_AFTER_MS,
    });
  });

  it.each([60_000, 30 * 24 * 60 * 60 * 1000])("accepts inclusive limit %s", (ms) => {
    expect(
      stuckWorkThresholds({
        STUCK_WORK_NOTIFY_AFTER_MS: ` ${ms} `,
        STUCK_WORK_EXPIRE_AFTER_MS: String(ms),
      }),
    ).toEqual({ notifyAfterMs: ms, expireAfterMs: ms });
  });

  it("falls back independently and caps the reminder at expiration", () => {
    expect(stuckWorkThresholds({ STUCK_WORK_NOTIFY_AFTER_MS: "60000" })).toEqual({
      notifyAfterMs: 60_000,
      expireAfterMs: STUCK_WORK_EXPIRE_AFTER_MS,
    });
    expect(stuckWorkThresholds({ STUCK_WORK_EXPIRE_AFTER_MS: "60000" })).toEqual({
      notifyAfterMs: 60_000,
      expireAfterMs: 60_000,
    });
    expect(
      stuckWorkThresholds({
        STUCK_WORK_NOTIFY_AFTER_MS: "180000",
        STUCK_WORK_EXPIRE_AFTER_MS: "120000",
      }),
    ).toEqual({ notifyAfterMs: 120_000, expireAfterMs: 120_000 });
  });

  it.each(["queued", "waiting_input"] as const)("applies configured boundaries to %s", (status) => {
    vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", "60000");
    vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", "120000");
    const action = (ageMs: number, alreadyNotified = false) =>
      stuckWorkAction({ status, ageMs, alreadyNotified });
    expect(stuckWorkDueAfterMs(status)).toBe(60_000);
    expect(action(59_999)).toBe("none");
    expect(action(60_000)).toBe("notify");
    expect(action(60_000, true)).toBe("none");
    expect(action(119_999, true)).toBe("none");
    expect(action(120_000)).toBe("expire");
    expect(action(120_000, true)).toBe("expire");
    expect(isAgedStuckWork(status, new Date(0), 60_000)).toBe(false);
    expect(isAgedStuckWork(status, new Date(0), STUCK_WORK_NOTIFY_AFTER_MS)).toBe(true);
  });

  it("cancels without reminding when the resolved thresholds coincide", () => {
    vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", "180000");
    vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", "120000");
    expect(stuckWorkDueAfterMs("queued")).toBe(120_000);
    expect(stuckWorkAction({ status: "queued", ageMs: 119_999, alreadyNotified: false })).toBe(
      "none",
    );
    expect(stuckWorkAction({ status: "queued", ageMs: 120_000, alreadyNotified: false })).toBe(
      "expire",
    );
  });

  it.each(["60000", "2592000000"])(
    "keeps takeover expiration fixed with custom thresholds %s",
    (value) => {
      vi.stubEnv("STUCK_WORK_NOTIFY_AFTER_MS", value);
      vi.stubEnv("STUCK_WORK_EXPIRE_AFTER_MS", value);
      expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(TAKEOVER_WAIT_EXPIRE_AFTER_MS);
      expect(
        stuckWorkAction({
          status: "waiting_takeover",
          ageMs: TAKEOVER_WAIT_EXPIRE_AFTER_MS - 1,
          alreadyNotified: false,
        }),
      ).toBe("none");
      expect(
        stuckWorkAction({
          status: "waiting_takeover",
          ageMs: TAKEOVER_WAIT_EXPIRE_AFTER_MS,
          alreadyNotified: false,
        }),
      ).toBe("expire");
    },
  );

  it("exposes browser-safe threshold helpers through shared core", async () => {
    const core = await import("./index.js");
    vi.stubGlobal("process", undefined);
    let thresholds: ReturnType<typeof stuckWorkThresholds> | undefined;
    let dueAfterMs: number | undefined;
    try {
      thresholds = core.stuckWorkThresholds();
      dueAfterMs = core.stuckWorkDueAfterMs("queued");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(thresholds).toEqual({
      notifyAfterMs: STUCK_WORK_NOTIFY_AFTER_MS,
      expireAfterMs: STUCK_WORK_EXPIRE_AFTER_MS,
    });
    expect(dueAfterMs).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
  });
});

describe("stuck work age", () => {
  it("stays quiet until the reminder, then cancels at the longer limit", () => {
    const action = (ageMs: number, alreadyNotified: boolean) =>
      stuckWorkAction({ status: "waiting_input", ageMs, alreadyNotified });
    expect(stuckWorkDueAfterMs("waiting_input")).toBe(STUCK_WORK_NOTIFY_AFTER_MS);
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS, false)).toBe("none");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS - 1, false)).toBe("none");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS, false)).toBe("notify");
    expect(action(STUCK_WORK_NOTIFY_AFTER_MS, true)).toBe("none");
    expect(action(STUCK_WORK_EXPIRE_AFTER_MS - 1, true)).toBe("none");
    expect(action(STUCK_WORK_EXPIRE_AFTER_MS, true)).toBe("expire");
  });

  it("cancels a takeover nobody acted on after half an hour", () => {
    const action = (ageMs: number) =>
      stuckWorkAction({ status: "waiting_takeover", ageMs, alreadyNotified: false });
    expect(stuckWorkDueAfterMs("waiting_takeover")).toBe(TAKEOVER_WAIT_EXPIRE_AFTER_MS);
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS - 1)).toBe("none");
    expect(action(TAKEOVER_WAIT_EXPIRE_AFTER_MS)).toBe("expire");
  });

  it("treats only queued and human waits as stuck", () => {
    expect(isStuckWorkStatus("queued")).toBe(true);
    expect(isStuckWorkStatus("waiting_input")).toBe(true);
    expect(isStuckWorkStatus("waiting_takeover")).toBe(true);
    expect(isStuckWorkStatus("running")).toBe(false);
    expect(isAgedStuckWork("queued", new Date(Date.now() - STUCK_WORK_NOTIFY_AFTER_MS))).toBe(true);
    expect(isAgedStuckWork("running", new Date(0))).toBe(false);
    expect(isAgedStuckWork("queued", "not-a-date")).toBe(false);
  });

  it("uses a distinct status line and a matching stopped notice", () => {
    const messages = STUCK_WORK_STATUSES_FOR_TEST();
    expect(new Set(messages).size).toBe(messages.length);
    expect(stuckWorkStatusMessage("waiting_takeover")).toMatch(/screen/);
    expect(stuckWorkStoppedNotification("waiting_input", "  ")).toEqual({
      kind: "failure",
      title: "Bot stopped",
      body: stuckWorkStatusMessage("waiting_input"),
    });
    expect(stuckWorkReminder("waiting_takeover", "Ada")).toMatchObject({
      kind: "takeover",
      title: "Ada still needs you",
    });
    expect(stuckWorkReminder("queued", "Ada").kind).toBe("help");
  });
});

function STUCK_WORK_STATUSES_FOR_TEST(): string[] {
  return [...stuckWorkStatusMessages()];
}
